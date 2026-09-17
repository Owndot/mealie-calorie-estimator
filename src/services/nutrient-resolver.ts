import { getProviderChain } from "./providers/registry.js"
import { config } from "../config.js"
import { UNKNOWN_ATTRIBUTES } from "../types.js"
import { unmetModifierFamilies } from "./providers/food-semantics.js"
import { orderCandidates, poolFingerprint } from "./providers/judge/candidate-pool.js"
import { askJudge, JUDGE_PROMPT_VERSION } from "./providers/judge/judge.js"
import type { JudgeCandidate, JudgeVerdict } from "./providers/judge/types.js"
import { sanityCheckNutrients } from "./sanity-check.js"
import { statedModifierFamilies } from "./providers/food-semantics.js"
import { logger } from "../utils/logger.js"
import type { ProviderQuery } from "./providers/types.js"
import type { FoodRoute, FallbackStatus, ProviderMatch } from "../types.js"

export interface ResolvedNutrients {
  match: ProviderMatch
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

async function resolveDeterministic(query: ProviderQuery, route: FoodRoute): Promise<ResolvedNutrients | null> {
  const chain = getProviderChain(route)

  // Highest-trust match that shares the identity but drops a stated nutritional claim. Kept in
  // case nothing better turns up; the chain is ordered by trust, so the first one found is the one
  // worth keeping.
  let shortfall: ResolvedNutrients | null = null

  for (const provider of chain) {
    let match: ProviderMatch | null
    try {
      match = await provider.lookup(query)
    } catch (err) {
      logger.warn({ err, provider: provider.name, foodName: query.foodName }, "Provider lookup failed")
      continue
    }

    if (!match) continue

    const check = sanityCheckNutrients(match.nutrients, query.foodName)
    if (!check.ok) {
      logger.info({ provider: provider.name, foodName: query.foodName, reason: check.reason }, "Rejected candidate on sanity check")
      continue
    }

    const resolved = { match, fallbackStatus: toFallbackStatus(provider.name) }

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
  if (!config.llm.judgeEnabled) return resolveDeterministic(query, route)

  // The pool is collected DURING the chain, from providers that were going to compute it anyway.
  // Nothing extra is retrieved and nothing is re-ranked.
  const pool: JudgeCandidate[] = []
  const deterministic = await resolveDeterministic(
    { ...query, candidateSink: (candidates) => { pool.push(...candidates) } },
    route,
  )

  // FAST PATH: a real record answered. It is kept exactly as it is, and the judge is never asked.
  if (deterministic && RECORD_PROVIDERS.has(deterministic.fallbackStatus)) return deterministic

  const trigger = pool.length > 0 ? "gate-suppressed-pool" : "no-database-record"
  if (pool.length === 0) return deterministic

  const ordered = orderCandidates(pool, config.llm.judgeMaxCandidates)
  const attrs = query.attributes ?? UNKNOWN_ATTRIBUTES
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
