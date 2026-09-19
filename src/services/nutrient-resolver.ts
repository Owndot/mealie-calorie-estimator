import { getProviderChain } from "./providers/registry.js"
import { config } from "../config.js"
import { UNKNOWN_ATTRIBUTES } from "../types.js"
import { foodTypeConflict, findMismatch } from "./providers/ranking.js"
import { inferAttributesFromName, formConflict, preservationConflict, freshVsProcessedFormConflict, fatConflict, unmetModifierFamilies } from "./providers/food-semantics.js"
import { poolFingerprint } from "./providers/judge/candidate-pool.js"
import { buildShortlist } from "./providers/judge/shortlist.js"
import { searchOff, filterOffHits, offProxyJustified, offLastResortJustified } from "./providers/judge/off-proxy.js"
import { askJudge, JUDGE_PROMPT_VERSION } from "./providers/judge/judge.js"
import type { JudgeCandidate, JudgeVerdict } from "./providers/judge/types.js"
import { sanityCheckNutrients } from "./sanity-check.js"
import { loadBlsRecordByCode } from "./providers/bls-provider.js"
import { loadUsdaRecordById } from "./providers/usda-local-provider.js"
import { narrowsAmbiguousIngredient } from "./vocabulary/recipe-vocabulary.js"
import { statedModifierFamilies } from "./providers/food-semantics.js"
import { normalizeIdentityText } from "../utils/text-normalize.js"
import { logger } from "../utils/logger.js"
import type { ProviderQuery } from "./providers/types.js"
import type { FoodRoute, FallbackStatus, ProviderMatch } from "../types.js"

export interface ResolvedNutrients {
  match: ProviderMatch
  /** Set only by the preferred-target branch, never inferred from a matching record id. */
  vocabularyPreferredSelected?: boolean
  fallbackStatus: FallbackStatus
  /** Present only when the semantic judge was actually asked about this ingredient. */
  judge?: {
    trigger: string
    verdict: JudgeVerdict | "invalid"
    reason: string
    candidates: number
    poolFingerprint: string
    model: string
    promptVersion: string
  }
}

const KNOWN_FALLBACK_STATUSES: FallbackStatus[] = ["mealie-recipe", "bls", "usda-local", "off", "llm-nutrient"]

/**
 * Maps a provider's `name` to a FallbackStatus without an unchecked cast — a provider whose name
 * doesn't match one of the known values would otherwise silently produce an invalid
 * fallbackStatus (this happened once already: the LLM provider was named "llm" while
 * FallbackStatus expected "llm-nutrient", so llmParticipated/provenance silently lost track of
 * LLM-resolved ingredients). Falls back to "unresolved" and logs loudly so a future rename can't
 * fail silently the same way.
 */
function toFallbackStatus(providerName: string): FallbackStatus {
  const match = KNOWN_FALLBACK_STATUSES.find((s) => s === providerName)
  if (match) return match
  logger.warn({ providerName }, "Provider name does not match any known FallbackStatus — check for a naming mismatch")
  return "unresolved"
}

/**
 * Walks the routing-aware provider chain for one ingredient, preferring a candidate that satisfies
 * the ingredient's MATERIAL NUTRITIONAL ATTRIBUTES over one that merely shares its identity.
 *
 * The chain used to stop at the first provider that returned anything, which made provider order
 * the only thing that mattered. Two production cases showed why that is not enough:
 *
 *   "mageres Rinderhackfleisch" -> BLS "Rind Hackfleisch, roh", unmetAttributes ["reduced-fat"].
 *      Correct base food, explicit "mager" dropped, 224 kcal/100 g at 16.4% fat — and at 400 g that
 *      ingredient is ~35% of the recipe.
 *   "Mayo Light" -> BLS "Salatmayonnaise", unmetAttributes ["reduced-fat"], while USDA holds an
 *      actual "Mayonnaise, light" record at 238 kcal against BLS's 490.
 *
 * In both, the system already KNEW the attribute was unmet and used the record anyway. So an
 * attribute shortfall no longer ends the search: the match is remembered and the chain continues.
 *
 * But continuing is not the same as replacing, and the first version of this conflated them. A
 * later match displaces the remembered one ONLY IF it positively answers the claim — its own record
 * name has to state it. Anything else keeps the database record, flagged. Production showed why the
 * weaker rule was wrong: for "mageres Rinderhackfleisch" the chain reached an LLM estimate of 250
 * kcal/100 g, MORE than the 224 kcal ordinary mince it displaced, and the resolver announced that
 * it satisfied "reduced-fat" — on no evidence beyond the estimate having no name to check.
 *
 * Food identity remains the hard requirement throughout — nothing here can promote a candidate
 * that failed the semantic gates, because such a candidate never reaches this function. This
 * chooses between records that are all already the right food.
 */
/**
 * Which of the shortfall's unmet claims this candidate does NOT positively answer.
 *
 * `unmetAttributes` is computed from the candidate's own NAME (unmetModifierFamilies), so a
 * provider that has no record name never computes it and reports nothing — indistinguishable, from
 * the outside, from a provider that checked and found nothing wrong. Reading that silence as
 * "satisfied" is what let a 250 kcal/100 g estimate displace a 224 kcal database record for
 * "mageres Rinderhackfleisch": the estimate was MORE energy-dense than the ordinary mince it
 * replaced, and the only thing that made it look leaner was that nobody had asked.
 *
 * So the question is asked the other way round. Displacing an identity-compatible record because
 * of a claim requires the replacement to make that claim itself, in a form something can read. A
 * record with no name states nothing and answers nothing.
 *
 * Numeric percentages deliberately play no part here: a stated percentage is a hard gate upstream
 * (fatConflict), never a modifier family, so it can never appear in a shortfall's unmet list and
 * there is nothing for it to answer.
 */
function unansweredBy(match: ProviderMatch, unmet: string[]): string[] {
  const stated = statedModifierFamilies(match.productName ?? "")
  return unmet.filter((family) => !stated.includes(family))
}

/**
 * The record the curated vocabulary prefers, if it is still usable.
 *
 * Validated the way a user-confirmed override is, and for the same reason: an id is a pointer into
 * a database that gets upgraded, so it is re-loaded live rather than trusted. It must still exist,
 * be nutritionally possible for the food asked for, and pass the existing supported semantic
 * conflict checks. Any of those failing is not an error — the vocabulary simply stops having an
 * opinion and normal resolution continues.
 */
async function preferredVocabularyMatch(query: ProviderQuery): Promise<ResolvedNutrients | null> {
  const preferred = query.vocabulary?.preferred
  if (!preferred) return null

  const record = preferred.provider === "bls"
    ? await loadBlsRecordByCode(preferred.id)
    : await loadUsdaRecordById(preferred.id)
  if (!record) {
    logger.info({ foodName: query.foodName, ...preferred }, "Recipe vocabulary: preferred record no longer exists, resolving normally")
    return null
  }
  const check = sanityCheckNutrients(record.nutrients, query.foodName)
  if (!check.ok) {
    logger.warn({ foodName: query.foodName, ...preferred, reason: check.reason }, "Recipe vocabulary: preferred record is not nutritionally possible, resolving normally")
    return null
  }
  // A state the INGREDIENT stated outranks the vocabulary's preference. "Cooked Puy Lentils" may
  // prefer the cooked record; a query that says "raw" must not be handed it.
  if (query.state !== "unknown" && record.state !== "unknown" && record.state !== query.state) {
    logger.info({ foodName: query.foodName, ...preferred, queryState: query.state, recordState: record.state }, "Recipe vocabulary: preferred record contradicts the stated state, resolving normally")
    return null
  }
  const attrs = query.attributes ?? UNKNOWN_ATTRIBUTES
  const recordAttrs = inferAttributesFromName(record.name)
  // Only REAL contradicting evidence may veto a reviewed pointer: an attribute the ingredient
  // actually states and the record actually denies.
  //
  // coreIdentityConflict deliberately does NOT participate. It exists to stop fuzzy RETRIEVAL
  // wandering off the queried food — it asks "does this candidate's name contain the core I
  // searched for?", which is the right question for a record the scorer found and the wrong one
  // for a record a human chose. A curated pointer IS the assertion that this alias means this
  // record, so re-deriving that link from the classifier's free-text core only lets the classifier
  // overrule the reviewer. Measured: "Basmatireis" -> BLS C352000 "Reis poliert, roh" is a
  // reviewed mapping, and with a classifier core of "Basmatireis" the compound gate rejected it
  // (the cultivar is absent from the record name) while all six other checks passed — so enabling
  // AI dropped a 351 kcal database record in favour of a fabricated estimate.
  //
  // Unchanged everywhere else: the gate still guards every ordinary provider match. This is
  // narrowly about validating a pointer a human already reviewed.
  const conflict = foodTypeConflict(query.foodType, record.foodType)
    || findMismatch(query.structuredName ?? query.foodName, record.name) !== null
    || formConflict(attrs.form, recordAttrs.form)
    || freshVsProcessedFormConflict(attrs.preservation, recordAttrs.form)
    || preservationConflict(attrs.preservation, recordAttrs.preservation)
    || fatConflict(attrs.fatPercent, record.nutrients.fatPer100g)
    || unmetModifierFamilies(query.structuredName ?? query.foodName, record.name).length > 0
  if (conflict) {
    logger.info({ foodName: query.foodName, ...preferred }, "Recipe vocabulary: preferred record contradicts or does not support stated semantics, resolving normally")
    return null
  }
  const match: ProviderMatch = {
    nutrients: record.nutrients, provider: preferred.provider, providerId: preferred.id,
    productName: record.name, canonicalName: record.name, brand: null, state: record.state,
    confidence: VOCABULARY_CONFIDENCE,
    matchReason: `recipe-vocabulary:${query.vocabulary?.kind ?? "entry"}`,
    foodType: record.foodType,
    ...("dataType" in record && typeof record.dataType === "string" ? { dataType: record.dataType } : {}),
  }
  return { match, fallbackStatus: toFallbackStatus(preferred.provider), vocabularyPreferredSelected: true }
}

/**
 * Reported confidence for a curated match. Below an exact database name match, because the row is
 * a human judgement about vocabulary rather than the database agreeing with the ingredient.
 */
const VOCABULARY_CONFIDENCE = 0.85

async function resolveDeterministic(query: ProviderQuery, route: FoodRoute): Promise<ResolvedNutrients | null> {
  const chain = getProviderChain(route)

  // Highest-trust match that shares the identity but drops a stated nutritional claim. Kept in
  // case nothing better turns up; the chain is ordered by trust, so the first one found is the one
  // worth keeping.
  let shortfall: ResolvedNutrients | null = null

  // Recipes, user overrides and branded-route OFF retain their priority over curated targets.
  let vocabularyPreference: ResolvedNutrients | null | undefined

  for (const provider of chain) {
    if ((provider.name === "bls" || provider.name === "usda-local") && vocabularyPreference === undefined) {
      vocabularyPreference = await preferredVocabularyMatch(query)
      if (vocabularyPreference) return vocabularyPreference
    }
    let match: ProviderMatch | null
    try {
      match = await provider.lookup(query)
    } catch (err) {
      logger.warn({ err, provider: provider.name, foodName: query.foodName }, "Provider lookup failed")
      continue
    }

    if (!match) continue

    // An alias the vocabulary marked ambiguous refuses a record that NARROWS it. "Bohnen" spans
    // 28-344 kcal/100 g, and the top-scoring bean is not evidence of which one was meant — a
    // withheld ingredient is recoverable, a confidently wrong one is not. A genuinely generic
    // record still passes.
    if (query.vocabulary?.ambiguous && match.productName
        && narrowsAmbiguousIngredient(query.structuredName ?? query.foodName, match.productName)) {
      logger.info({ provider: provider.name, foodName: query.foodName, record: match.productName },
        "Recipe vocabulary: ingredient is ambiguous and this record narrows it, declining")
      continue
    }

    const check = sanityCheckNutrients(match.nutrients, query.foodName)
    if (!check.ok) {
      logger.info({ provider: provider.name, foodName: query.foodName, reason: check.reason }, "Rejected candidate on sanity check")
      continue
    }

    // Derived from the MATCH's provider, not the chain entry's name. For every ordinary provider
    // these are the same string, because each sets `provider` to its own name. They differ for a
    // user-confirmed override, which is a reason rather than a source: the numbers really did come
    // from BLS/USDA/OFF, and provenance must say so. The override itself is recorded as
    // matchReason: "user-confirmed-override".
    const resolved = { match, fallbackStatus: toFallbackStatus(match.provider) }

    if ((match.unmetAttributes?.length ?? 0) === 0) {
      // Nothing to displace: first acceptable match wins, exactly as before.
      if (!shortfall) return resolved

      const unanswered = unansweredBy(match, shortfall.match.unmetAttributes ?? [])
      if (unanswered.length > 0) {
        logger.info(
          {
            foodName: query.foodName, provider: provider.name, record: match.productName,
            unanswered, keeping: shortfall.fallbackStatus, keepingRecord: shortfall.match.productName,
          },
          "Attribute-aware routing: candidate offers no evidence for the stated attribute, keeping the database fallback",
        )
        continue
      }

      logger.info(
        {
          foodName: query.foodName, chosen: provider.name, chosenRecord: match.productName,
          insteadOf: shortfall.fallbackStatus, insteadOfRecord: shortfall.match.productName,
          satisfied: shortfall.match.unmetAttributes,
        },
        "Attribute-aware routing: a later provider satisfies the stated nutritional attribute",
      )
      return resolved
    }

    if (!shortfall) {
      logger.info(
        { foodName: query.foodName, provider: provider.name, record: match.productName, unmet: match.unmetAttributes },
        "Attribute shortfall: keeping this as a fallback and continuing the chain",
      )
      shortfall = resolved
    }
  }

  // Nothing satisfied the claim. The best identity match still beats no answer at all, and it
  // carries its unmetAttributes into provenance and match quality so the gap is visible.
  if (shortfall) {
    logger.info(
      { foodName: query.foodName, provider: shortfall.fallbackStatus, record: shortfall.match.productName, unmet: shortfall.match.unmetAttributes },
      "Attribute-aware routing: no provider satisfied the stated attribute, using the best identity match",
    )
  }
  return shortfall
}


/** Providers whose answer is a real record rather than a generated value. */
const RECORD_PROVIDERS = new Set<FallbackStatus>(["mealie-recipe", "bls", "usda-local", "off"])

/**
 * The deterministic chain, with ONE strictly additive exception.
 *
 * The judge is asked exactly when there is nothing to protect: the whole chain has run and its
 * answer is a fabricated estimate or nothing at all, while real records DID survive every hard
 * semantic gate and were discarded only on score. That is the population the old
 * RERANK_MIN_CANDIDATE_SCORE floor hid — measured on the bundled corpus, eight of nine
 * gate-surviving black-bean records sat below it, both canned ones among them.
 *
 * Every other outcome leaves the chain exactly as it was:
 *
 *   an accepted record from any provider   -> returned untouched, no judge call, no pool built
 *   AMBIGUOUS / NONE / invalid / timeout   -> the existing llm-nutrient or unresolved result stands
 *   an id that is not in the pool          -> refused upstream in parseJudgeReply, treated as invalid
 *
 * So this function is MONOTONE: it can turn a fabricated number into a real record, and it cannot
 * make any currently-accepted result worse. Replacing an accepted record, answering an unmet
 * attribute, and the OFF proxy are deliberately NOT here.
 */
export async function resolveNutrients(query: ProviderQuery, route: FoodRoute): Promise<ResolvedNutrients | null> {
  // If the judge cannot actually be asked, do not pay for the pool pass either.
  if (!config.llm.judgeEnabled || !config.llm.enabled || !config.llm.apiKey) {
    return resolveDeterministic(query, route)
  }

  const deterministic = await resolveDeterministic(query, route)

  // FAST PATH: a real record answered. It is kept exactly as it is, the pool is never built, and
  // the judge is never asked. This is what makes the whole change free for the common case.
  if (deterministic && RECORD_PROVIDERS.has(deterministic.fallbackStatus)) return deterministic

  // Only now, for an ingredient the whole chain could not answer, collect what the LOCAL databases
  // had. It has to be a separate pass: a provider's negative cache short-circuits before anything
  // is scored, so once an ingredient is a known miss its survivors are never computed again —
  // measured in production as the judge being invoked for precisely zero ingredients. The pass
  // consults no cache, reranks nothing and issues no request (see ProviderQuery.poolOnly).
  const pool: JudgeCandidate[] = []
  const poolQuery = {
    ...query,
    poolOnly: true,
    candidateSink: (candidates: JudgeCandidate[]) => { pool.push(...candidates) },
  }
  for (const provider of getProviderChain(route)) {
    if (provider.name !== "bls" && provider.name !== "usda-local") continue
    try {
      await provider.lookup(poolQuery)
    } catch (err) {
      logger.warn({ err, provider: provider.name, foodName: query.foodName }, "Judge candidate collection failed")
    }
  }

  const attrs = query.attributes ?? UNKNOWN_ATTRIBUTES
  const structuredName = query.structuredName ?? query.foodName

  // What is actually unresolved about this ingredient, and whether the LOCAL databases can express
  // it. A generic composition database describes what a food IS, never how it is LABELLED, so a
  // qualitative claim ("mager", "light") is only ever evidenced by a retail product — while an
  // explicit number is something USDA files as a record of its own, and consulting OFF for it
  // would buy a network round trip and nothing else.
  const localShortlist = buildShortlist(pool, structuredName, attrs, config.llm.judgeMaxCandidates)
  const routing = offProxyJustified(localShortlist.propertyBearing, localShortlist.property.kind)

  // OFF is consulted on two different grounds, and they are deliberately separate questions.
  //
  //   PROXY      — the local databases hold the food but cannot express a property it claims
  //                ("mager", "light"). Strict filter, English core, narrow category allowance.
  //   LAST RESORT — nothing answered at all. The choice is OFF or nothing, so identity comes from
  //                the ingredient's own words and only never-an-ingredient categories are barred.
  //
  // Both end in the same place: the judge SELECTS among real records, or nothing changes.
  const lastResort = offLastResortJustified(
    deterministic !== null && RECORD_PROVIDERS.has(deterministic.fallbackStatus),
    localShortlist.propertyBearing,
  )
  let retail: JudgeCandidate[] = []
  const offRoute = routing.justified ? "proxy" : (lastResort.justified ? "last-resort" : null)
  if (offRoute) {
    try {
      const hits = await searchOff(structuredName)
      const filtered = filterOffHits(
        hits, [query.coreFoodGerman ?? null, query.coreFoodEnglish ?? null], attrs,
        offRoute === "last-resort" ? { lastResort: true, identityText: structuredName } : {},
      )
      retail = filtered.kept
      logger.debug(
        { foodName: query.foodName, route: offRoute, property: localShortlist.property.kind, rawHits: filtered.rawHits, kept: retail.length, dropped: filtered.dropped },
        "Judge OFF candidates: filter applied",
      )
    } catch (err) {
      // A search that fails changes nothing: the local pool still stands.
      logger.warn({ err, foodName: query.foodName, route: offRoute }, "Judge OFF search failed")
    }
  }

  const trigger = pool.length > 0 ? "gate-suppressed-pool" : "no-database-record"

  // ONE retail product whose whole label IS the ingredient outranks its own variants.
  //
  // "Leerdammer Leger" came back `ambiguous`: the model was shown twelve Leerdammer records and
  // could not say which variant was meant — reasonably, because the classifier had already
  // translated `Léger` to `Light`, so the English name it reasoned about matched no label at all.
  // Yet one candidate's complete name equals the complete ingredient text. That is not a
  // preference between variants; it is the product the cook named, and the others are noise.
  //
  // So the competing variants are withdrawn and the judge is still asked — it confirms the
  // identity or answers NO_SAFE_MATCH exactly as before. Removing a distraction is a different
  // thing from removing the semantic check, and only the first is safe.
  //
  // Narrow by construction and self-limiting where it should be: equality must be EXACT on the
  // whole normalized label, exactly one candidate may satisfy it, and only the last-resort route
  // qualifies — the property proxy is answering a fat percentage, not identifying a product. A
  // generic ingredient like `Hoisin-Sauce` matches many products all labelled "Hoisin Sauce", so
  // uniqueness fails and nothing changes. That is the difference between naming a product and
  // naming a food.
  if (offRoute === "last-resort" && retail.length > 1) {
    const exact = retail.filter((c) => normalizeIdentityText(c.name) === normalizeIdentityText(structuredName))
    if (exact.length === 1) {
      logger.info(
        { foodName: query.foodName, structuredName, record: exact[0].name, providerId: exact[0].providerId, withdrew: retail.length - 1 },
        "OFF exact label: the product name is the ingredient name, so its variants are withdrawn",
      )
      retail = exact
    }
  }

  if (pool.length === 0 && retail.length === 0) return deterministic

  // Rebuilt WITH the retail survivors, so they hold places of their own rather than competing on a
  // deterministic score they do not have.
  const ordered = buildShortlist(pool, structuredName, attrs, config.llm.judgeMaxCandidates, retail).offered
  if (ordered.length === 0) return deterministic
  const outcome = await askJudge({
    structuredName: query.structuredName ?? query.foodName,
    canonicalEnglish: query.foodName,
    canonicalGerman: query.canonicalGerman ?? null,
    coreFoodEnglish: query.coreFoodEnglish ?? null,
    state: query.state,
    form: attrs.form,
    preservation: attrs.preservation,
    fatPercent: attrs.fatPercent,
    category: query.category ?? null,
  }, ordered)

  const provenance = {
    trigger,
    candidates: ordered.length,
    poolFingerprint: poolFingerprint(ordered).slice(0, 16),
    model: config.llm.judgeModel,
    promptVersion: JUDGE_PROMPT_VERSION,
  }

  logger.info(
    {
      foodName: query.foodName,
      trigger,
      property: localShortlist.property.kind,
      candidates: ordered.length,
      retailOffered: ordered.filter((c) => c.provider === "off").length,
      // What actually happened, not what one of the two routes would have done. `routing` covers
      // only the property proxy, so a real last-resort search logged `offQueried: false` — which
      // made an audit of "was OFF even asked?" answer no while the network call was in the trace.
      offQueried: offRoute !== null,
      offRoute,
      verdict: outcome.decision?.verdict ?? "invalid",
      cached: outcome.cached ?? false,
      latencyMs: outcome.latencyMs,
      promptTokens: outcome.promptTokens,
      completionTokens: outcome.completionTokens,
      model: config.llm.judgeModel,
      promptVersion: JUDGE_PROMPT_VERSION,
    },
    "Semantic judge usage",
  )

  const decision = outcome.decision
  if (!decision || decision.verdict !== "selected" || !decision.candidateId) {
    // AMBIGUOUS, NONE, a discarded reply, a timeout or an error all land here, and all mean the
    // same thing: nothing changes. "No record" is a correct and expected answer.
    logger.info(
      { foodName: query.foodName, trigger, verdict: decision?.verdict ?? "invalid", reason: outcome.invalidReason ?? decision?.reason },
      "Semantic judge did not select a record — the deterministic outcome stands",
    )
    return deterministic === null ? null : {
      ...deterministic,
      judge: { ...provenance, verdict: decision?.verdict ?? "invalid", reason: decision?.reason ?? outcome.invalidReason ?? "" },
    }
  }

  const picked = ordered.find((c) => c.id === decision.candidateId)
  if (!picked) return deterministic

  if (decision.confidence < config.llm.judgeMinConfidence) {
    logger.info(
      { foodName: query.foodName, record: picked.name, confidence: decision.confidence, floor: config.llm.judgeMinConfidence },
      "Judge selection below the confidence floor — keeping the deterministic outcome",
    )
    return deterministic === null ? null : {
      ...deterministic,
      judge: { ...provenance, verdict: "selected", reason: `below confidence floor: ${decision.reason}` },
    }
  }

  // The nutrients are the RECORD's, copied verbatim. The model supplied an id and nothing else.
  const check = sanityCheckNutrients(picked.nutrients, query.foodName)
  if (!check.ok) {
    logger.info({ foodName: query.foodName, record: picked.name, reason: check.reason }, "Judge-selected record failed the sanity check — keeping the deterministic outcome")
    return deterministic
  }

  const match: ProviderMatch = {
    nutrients: picked.nutrients,
    canonicalName: query.foodName,
    brand: query.brand,
    state: query.state,
    provider: picked.provider,
    providerId: picked.providerId,
    productName: picked.name,
    // Capped like the reranker's: a model-assisted SELECTION never earns a deterministic match's
    // confidence, however sure the model says it is.
    confidence: Math.min(0.75, decision.confidence),
    dataType: picked.dataType,
    matchReason: "judge-selected",
    ...(unmetModifierFamilies(query.structuredName ?? query.foodName, picked.name).length > 0
      ? { unmetAttributes: unmetModifierFamilies(query.structuredName ?? query.foodName, picked.name) }
      : {}),
  }

  logger.info(
    {
      foodName: query.foodName, trigger, record: picked.name, provider: picked.provider,
      providerId: picked.providerId, kcal: picked.nutrients.kcalPer100g,
      insteadOf: deterministic?.fallbackStatus ?? "unresolved",
      wasKcal: deterministic?.match.nutrients.kcalPer100g ?? null,
      candidates: ordered.length, cached: outcome.cached ?? false,
    },
    "Semantic judge selected a real record in place of a fabricated estimate",
  )

  return {
    match,
    fallbackStatus: toFallbackStatus(picked.provider),
    judge: { ...provenance, verdict: "selected", reason: decision.reason },
  }
}
