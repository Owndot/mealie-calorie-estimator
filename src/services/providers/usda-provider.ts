import { config } from "../../config.js"
import { logger } from "../../utils/logger.js"
import { waitForRateLimit, RateLimitType } from "../../utils/rate-limiter.js"
import { getCachedProviderMatch, setCachedProviderMatch, isProviderMiss, markProviderMiss, buildQueryKey } from "../../utils/cache.js"
import type { NutrientSet, ProviderMatch, FoodRoute, FoodType } from "../../types.js"
import type { NutrientProvider, ProviderQuery } from "./types.js"
import { rankCandidates, MIN_ACCEPTABLE_SCORE, inferStateFromName, cachedMatchConflict, matchingContextKey, tokenize, GENERIC_DESCRIPTOR_WORDS, type RankableCandidate, type RankedCandidate } from "./ranking.js"
import { FULL_EVIDENCE } from "../identity-evidence.js"
import { attributesKey, inferAttributesFromName, unmetModifierFamilies } from "./food-semantics.js"
import { rerankCandidates, rerankTrigger, identityKey, RERANK_MIN_CANDIDATE_SCORE, type TriggerCandidate } from "./candidate-rerank.js"
import { UNKNOWN_ATTRIBUTES, type FoodAttributes } from "../../types.js"

interface FdcNutrient {
  nutrientId: number
  nutrientName: string
  unitName: string
  value: number
}

interface FdcFood {
  fdcId: number
  description: string
  brandOwner?: string | null
  brandName?: string | null
  dataType?: string
  /** USDA's own structured category tag (e.g. "Vegetables and Vegetable Products", "Pudding",
   * "Baby Foods", "Nut & Seed Butters") — authoritative metadata, not derived from the free-text
   * description. See usdaFoodType(). */
  foodCategory?: string | null
  foodNutrients: FdcNutrient[]
}

interface FdcSearchResult {
  foods: FdcFood[]
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504])

/**
 * USDA FoodData Central nutrient IDs — stable identifiers, never array position. Energy is
 * reported by USDA as TWO separate entries for the same food (1008 = kcal, 1062 = kJ); we
 * deliberately only ever read 1008, so a kJ figure can never be mistaken for kcal.
 */
const NUTRIENT_IDS = {
  energyKcal: 1008,
  protein: 1003,
  carbs: 1005,
  fat: 1004,
  saturatedFat: 1258,
  transFat: 1257,
  fiber: 1079,
  sugar: 2000,
  sodiumMg: 1093,
  cholesterolMg: 1253,
}

/**
 * Bumped whenever ranking/rejection behavior changes (dataType tiering, state/category
 * conflicts, branded exclusion) — provider_match_cache has no other versioning, so a future
 * fix would otherwise be silently masked by up to CACHE_MATCH_TTL of stale cached matches for
 * any already-resolved ingredient text (same pattern as bls-provider.ts's BLS_MATCH_ALGORITHM_VERSION).
 */
const USDA_MATCH_ALGORITHM_VERSION = "v18"

/**
 * Dataset-tier ranking signal — NOT a hard filter by itself (categoryConflict/findMismatch/state
 * conflicts still apply on top). Foundation and SR Legacy are curated, single-ingredient-focused
 * datasets; Survey (FNDDS) is the next best generic tier. Branded is excluded outright before
 * ranking even runs on the generic route (see `lookup()`), so this function never actually scores
 * a Branded candidate there — only on the branded route, where a small positive nudge reflects
 * "acceptable if it otherwise ranks well," never enough to beat a clearly better generic tier.
 */
function dataTypeScore(route: FoodRoute, dataType: string | null | undefined): number {
  if (dataType === "Foundation") return 20
  if (dataType === "SR Legacy") return 15
  if (dataType === "Survey (FNDDS)") return 10
  if (dataType === "Branded") return route === "branded" ? 5 : 0
  return 0
}

/**
 * Category strings (from USDA's OWN `foodCategory` field — authoritative metadata, not a
 * lexical guess on the description) that reliably signal a multi-ingredient prepared dish/meal,
 * never a correct answer for a "simple"/"processed_single_food" query regardless of how well its
 * *name* happens to textually match. Verified against the real API: querying "banana" surfaces a
 * "BANANA"-branded product whose foodCategory is "Nut & Seed Butters" (a processed product, not a
 * dish, so intentionally NOT listed here — that case is caught by the Branded-exclusion instead);
 * "Egg, Benedict"/"Egg, creamed" fall under "Eggs and omelets" (still egg-adjacent, so also not
 * listed — the lexical layer catches "Benedict"/"creamed" by name). This list only covers
 * genuinely composite dish/meal/dessert/snack categories confirmed live.
 */
const USDA_COMPOSITE_DISH_CATEGORIES = [
  "pudding", "cakes and pies", "ice cream and frozen dairy desserts", "baby food",
  "fast foods", "soups, sauces, and gravies", "restaurant foods", "meals, entrees, and side dishes",
  "sandwiches", "mixed dishes", "cookies and brownies", "candy",
]

function usdaFoodType(foodCategory: string | null | undefined): FoodType {
  if (!foodCategory) return "unknown"
  const normalized = foodCategory.toLowerCase()
  return USDA_COMPOSITE_DISH_CATEGORIES.some((c) => normalized.includes(c)) ? "composite_dish" : "simple"
}

async function fetchWithRetry(url: string): Promise<Response | null> {
  const { maxRetries, retryBackoffMs } = config.usda
  let lastResponse: Response | null = null

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const delay = retryBackoffMs * 2 ** (attempt - 1)
      await new Promise((resolve) => setTimeout(resolve, delay))
    }

    try {
      const res = await fetch(url)
      if (res.ok || !RETRYABLE_STATUS.has(res.status)) return res
      lastResponse = res
    } catch {
      lastResponse = null
    }
  }

  return lastResponse
}

function findNutrient(food: FdcFood, nutrientId: number): number | null {
  const match = food.foodNutrients.find((n) => n.nutrientId === nutrientId)
  return match ? match.value : null
}

function extractNutrients(food: FdcFood): NutrientSet {
  const fat = findNutrient(food, NUTRIENT_IDS.fat)
  const saturated = findNutrient(food, NUTRIENT_IDS.saturatedFat)
  const trans = findNutrient(food, NUTRIENT_IDS.transFat)

  let unsaturated: number | null = null
  if (fat !== null) {
    const s = saturated ?? 0
    const t = trans ?? 0
    unsaturated = Math.round((fat - s - t) * 10) / 10
  }

  const sodiumMg = findNutrient(food, NUTRIENT_IDS.sodiumMg)
  const cholesterolMg = findNutrient(food, NUTRIENT_IDS.cholesterolMg)

  return {
    kcalPer100g: findNutrient(food, NUTRIENT_IDS.energyKcal),
    proteinPer100g: findNutrient(food, NUTRIENT_IDS.protein),
    carbsPer100g: findNutrient(food, NUTRIENT_IDS.carbs),
    fatPer100g: fat,
    saturatedFatPer100g: saturated,
    transFatPer100g: trans,
    unsaturatedFatPer100g: unsaturated,
    fiberPer100g: findNutrient(food, NUTRIENT_IDS.fiber),
    sugarPer100g: findNutrient(food, NUTRIENT_IDS.sugar),
    // USDA reports sodium/cholesterol in mg; NutrientSet keeps the same grams/100g convention
    // as every other provider (OFF), so convert here at the provider boundary.
    sodiumPer100g: sodiumMg !== null ? sodiumMg / 1000 : null,
    cholesterolPer100g: cholesterolMg !== null ? cholesterolMg / 1000 : null,
  }
}



/**
 * True when a multi-word core is only partly present in the candidate name.
 *
 * "chili pepper" against "Peppers, sweet, red, raw" matches the generic head and loses the word
 * that carried the identity — which is how a chili became a sweet bell pepper in production, right
 * after BLS's own reranker had declined its chili candidates. A single-word core is excluded: the
 * core gate already requires it outright, and demanding more would fire on every ordinary match.
 *
 * This is a question, not a verdict: it only asks the judge to look. "bell pepper" against
 * "Peppers, sweet, raw" is the same shape and IS correct, which is precisely why the decision
 * belongs to a semantic judge rather than another lexical rule.
 */
function answersOnlyPartOfCore(core: string | null | undefined, candidateName: string): boolean {
  const coreTokens = tokenize(core ?? "").filter((t) => t.length >= 3 && !GENERIC_DESCRIPTOR_WORDS.has(t))
  if (coreTokens.length < 2) return false
  const candidate = tokenize(candidateName)
  const matched = coreTokens.filter((c) => candidate.some((t) => t === c || t === `${c}s` || c === `${t}s`))
  return matched.length > 0 && matched.length < coreTokens.length
}

/** English identity of a candidate name: the words that actually name a food. */
function identityTokensOf(name: string): string[] {
  const kept = tokenize(name).filter((t) => t.length >= 3 && !/^\d/.test(t) && !GENERIC_DESCRIPTOR_WORDS.has(t))
  return kept.length > 0 ? kept : tokenize(name)
}

/** A ranked USDA candidate carrying the rerank outcome, when one happened. */
type RankedUsda = RankedCandidate<RankableFdcFood> & { rerankConfidence?: number; rerankReason?: string | null }

interface RankableFdcFood extends RankableCandidate {
  food: FdcFood
}

/**
 * USDA FoodData Central provider — a real, optional generic-route fallback (tried after BLS).
 * Only constructed and added to the provider registry when USDA_API_KEY is configured; there is
 * no dummy placeholder occupying this slot when it's absent.
 *
 * NEVER accepts foods[0] just because FoodData Central returned it first: verified live that a
 * plain "banana" search returns a branded product literally named "BANANA" as the top full-text
 * search hit, ahead of any genuine raw-banana entry. This provider always retrieves a page of
 * candidates and ranks them itself (rankCandidates, with dataType/state/category awareness) —
 * search relevance order is a hint, never nutritional identity.
 */
export class UsdaProvider implements NutrientProvider {
  readonly name = "usda"

  async lookup(query: ProviderQuery): Promise<ProviderMatch | null> {
    const route: FoodRoute = query.route ?? "generic"

    // State participates in cache identity (mirrors bls-provider.ts) — ranking now rejects on a
    // known state conflict, so a "cooked" resolution must not be silently reused for the same
    // food name queried "raw"/"unknown". Route also participates: the *same* food name can
    // legitimately resolve differently on the generic vs branded route (Branded is excluded
    // outright on generic).
    const attrs = query.attributes ?? UNKNOWN_ATTRIBUTES
    const queryKey = buildQueryKey(`${USDA_MATCH_ALGORITHM_VERSION}:${query.foodName}|${query.state}|${route}|${attributesKey(attrs)}`, query.brand)

    // category/foodType/coreFood are not part of the positive key by design — re-checked against
    // the stored candidate instead (cachedMatchConflict). The NEGATIVE key does carry them, since
    // a miss has no stored candidate to re-check. See matchingContextKey().
    const evidence = query.evidence ?? FULL_EVIDENCE
    // USDA indexes ENGLISH descriptions. With a validated English identity this is the normal
    // generic path. Without one, the query text is the raw structured name and the ONLY identity
    // available to gate with is that same name — so it is used as the core-identity gate.
    //
    // That gate is self-limiting, which is the point: a German word is absent from every correct
    // English candidate name ("Minze" vs "Peppermint, fresh" -> conflict), so a German-only
    // ingredient fails closed without needing a language detector, while a structured-English name
    // like "olive oil" matches "Oil, olive, ..." and is allowed through.
    const strictCore = evidence.english ? query.coreFoodEnglish : (query.structuredName ?? query.foodName)
    const ctx = {
      foodName: query.foodName, category: query.category, foodType: query.foodType, coreFood: strictCore, coreMatchMode: "token" as const,
      evidence,
      attributes: attrs,
    }
    const missKey = `${queryKey}|ctx=${matchingContextKey(ctx)}`

    const cached = getCachedProviderMatch(this.name, queryKey)
    if (cached) {
      const conflict = cachedMatchConflict(cached, ctx)
      if (!conflict) return cached
      // True cache miss for this context — fall through and re-rank live.
      logger.info({ foodName: query.foodName, reason: conflict }, "USDA: cached match incompatible with this query's context, re-querying")
    }
    if (isProviderMiss(this.name, missKey)) return null

    const searchTerm = query.brand ? `${query.brand} ${query.foodName}` : query.foodName
    const params = new URLSearchParams({
      api_key: config.usda.apiKey,
      query: searchTerm,
      // Fetch a real page of candidates to rank ourselves — never just the top hit. dataType is
      // deliberately NOT restricted at the API level: filtering it there would just move the
      // "trust the API's judgment" problem instead of removing it, and we want Branded results
      // visible to our own ranking (so branded-route matching can still consider them) rather
      // than silently absent.
      pageSize: "25",
    })
    const url = `${config.usda.baseUrl}/foods/search?${params}`

    await waitForRateLimit(RateLimitType.Usda)
    const res = await fetchWithRetry(url)

    if (!res) {
      logger.warn({ foodName: query.foodName }, "USDA search failed after retries")
      return null // transient — never poison the negative cache
    }
    if (!res.ok) {
      logger.warn({ foodName: query.foodName, status: res.status }, "USDA search returned error")
      return null // transient — never poison the negative cache
    }

    let data: FdcSearchResult
    try {
      data = (await res.json()) as FdcSearchResult
    } catch {
      logger.warn({ foodName: query.foodName }, "USDA returned non-JSON response")
      return null // transient — never poison the negative cache
    }

    if (!data.foods || data.foods.length === 0) {
      markProviderMiss(this.name, missKey)
      return null
    }

    // Branded is excluded outright before ranking on the generic route — never a correct
    // generic-ingredient answer regardless of textual search score (the "banana" failure mode).
    const eligible = route === "generic" ? data.foods.filter((f) => f.dataType !== "Branded") : data.foods

    if (eligible.length === 0) {
      markProviderMiss(this.name, missKey)
      return null
    }

    const rankable: RankableFdcFood[] = eligible.map((food) => ({
      food,
      name: food.description,
      brand: food.brandOwner ?? food.brandName ?? null,
      hasCompleteNutrients: findNutrient(food, NUTRIENT_IDS.energyKcal) != null,
      dataType: food.dataType ?? null,
      state: inferStateFromName(food.description),
      foodType: usdaFoodType(food.foodCategory),
    }))

    const ranked = rankCandidates(query.foodName, query.brand, rankable, {
      queryState: query.state,
      queryCategory: query.category,
      queryFoodType: query.foodType,
      queryCoreFood: strictCore,
      coreMatchMode: "token" as const,
      queryAttributes: attrs,
      candidateFat: (c) => findNutrient((c as RankableFdcFood).food, NUTRIENT_IDS.fat),
      rejectBrandedWithoutBrandEvidence: route === "generic" && !query.brand,
      dataTypeScore: (dt) => dataTypeScore(route, dt),
    })
    // The same semantic judge BLS uses, applied here too. Found live: BLS's reranker correctly
    // declined its chili candidates, and USDA then accepted "Peppers, sweet, red, raw" for "rote
    // Chilischoten" a moment later — a distinction rejected upstream reintroduced downstream
    // because the safety rules stopped at the BLS boundary.
    const reranked = await this.maybeRerank(query, ranked, attrs, strictCore)
    const top: RankedUsda | undefined = reranked ?? ranked[0]

    if (!top) {
      markProviderMiss(this.name, missKey)
      return null
    }

    // Checked before the score gate for the same reason off-provider.ts does: a mismatch always
    // drags the score below MIN_ACCEPTABLE_SCORE too, so checking score first would hide the
    // specific rejection reason behind a generic "no acceptable candidate" log.
    if (top.mismatchReason) {
      logger.info({ foodName: query.foodName, reason: top.mismatchReason }, "USDA: rejected obvious mismatch")
      markProviderMiss(this.name, missKey)
      return null
    }

    if (top.score < MIN_ACCEPTABLE_SCORE) {
      logger.debug({ foodName: query.foodName, topScore: top.score }, "USDA: no acceptable candidate")
      markProviderMiss(this.name, missKey)
      return null
    }

    const food = top.candidate.food
    const nutrients = extractNutrients(food)
    if (nutrients.kcalPer100g === null) {
      markProviderMiss(this.name, missKey)
      return null
    }

    const match: ProviderMatch = {
      nutrients,
      canonicalName: query.foodName,
      brand: food.brandOwner ?? food.brandName ?? query.brand,
      state: query.state,
      provider: this.name,
      providerId: String(food.fdcId),
      productName: food.description,
      // Same semantic basis as BLS, one step lower throughout: USDA is reached through an English
      // translation of the ingredient, so there is one more place for the identity to drift.
      confidence: top.rerankConfidence !== undefined
        ? Math.min(0.8, top.rerankConfidence)
        : !strictCore?.trim()
          ? Math.min(0.55, top.score / 100)
          : top.score >= MIN_ACCEPTABLE_SCORE + 25 ? 0.8 : 0.7,
      dataType: food.dataType ?? null,
      foodType: usdaFoodType(food.foodCategory),
      matchReason: top.rerankConfidence !== undefined
        ? "llm-reranked"
        : query.foodName.trim().toLowerCase() === food.description.trim().toLowerCase() ? "exact-name" : "fuzzy",
      ...(top.rerankConfidence !== undefined ? { llmReranked: true as const, rerankReason: top.rerankReason ?? null } : {}),
    }

    setCachedProviderMatch(this.name, queryKey, match)
    return match
  }

  /**
   * Asks the shared semantic judge when this lookup is ambiguous. Returns the reranked candidate,
   * or null meaning "nothing changes" — every failure, NONE, and a below-threshold confidence all
   * leave the deterministic ordering exactly as it was.
   */
  private async maybeRerank(
    query: ProviderQuery,
    ranked: RankedCandidate<RankableFdcFood>[],
    attrs: FoodAttributes,
    core: string | null | undefined,
  ): Promise<RankedUsda | null> {
    if (!config.llm.enabled || !config.llm.apiKey || !config.llm.rerankEnabled) return null

    const asTrigger = (r: RankedCandidate<RankableFdcFood>): TriggerCandidate => ({
      score: r.score,
      record: {
        blsCode: String(r.candidate.food.fdcId),
        nutrients: { kcalPer100g: findNutrient(r.candidate.food, NUTRIENT_IDS.energyKcal) },
        attributes: inferAttributesFromName(r.candidate.name),
        inferredState: r.candidate.state ?? "unknown",
        identityTokens: identityTokensOf(r.candidate.name),
      },
    })

    // Only gate-surviving candidates carrying real identity evidence are ever offered.
    const eligible = ranked.filter((r) => !r.mismatchReason && r.score >= RERANK_MIN_CANDIDATE_SCORE)
    if (eligible.length === 0) return null
    const pool = new Map(eligible.map((r) => [String(r.candidate.food.fdcId), asTrigger(r)]))

    const accepted = ranked[0] && !ranked[0].mismatchReason && ranked[0].score >= MIN_ACCEPTABLE_SCORE ? ranked[0] : null
    const reason = rerankTrigger(accepted ? asTrigger(accepted) : null, pool, attrs, query.state)
      ?? (accepted && answersOnlyPartOfCore(core, accepted.candidate.name) ? "partial-core" : null)
    if (!reason) return null

    const offered = eligible.slice(0, config.llm.rerankMaxCandidates)
    const decision = await rerankCandidates(
      {
        provider: this.name,
        structuredName: query.structuredName ?? query.foodName,
        canonicalGerman: query.canonicalGerman ?? null,
        canonicalEnglish: query.foodName,
        coreFood: core ?? null,
        state: query.state,
        attributes: attrs,
      },
      offered.map((r) => ({
        providerId: String(r.candidate.food.fdcId),
        productName: r.candidate.name,
        kcalPer100g: findNutrient(r.candidate.food, NUTRIENT_IDS.energyKcal),
        form: inferAttributesFromName(r.candidate.name).form,
        preservation: inferAttributesFromName(r.candidate.name).preservation,
        score: r.score,
        unmet: unmetModifierFamilies(query.foodName, r.candidate.name),
      })),
    )

    if (!decision) return null
    if (decision.providerId === null) {
      // An explicit NONE is a rejection of the whole field, including whatever ranked first.
      logger.info({ foodName: query.foodName, trigger: reason, reason: decision.reason }, "USDA: rerank declined every candidate")
      return { candidate: offered[0].candidate, score: -1000, mismatchReason: `rerank declined: ${decision.reason}` }
    }

    const selected = offered.find((r) => String(r.candidate.food.fdcId) === decision.providerId)
    if (!selected) return null
    if (accepted && identityKey(asTrigger(selected).record.identityTokens) === identityKey(asTrigger(accepted).record.identityTokens)) return null

    return { ...selected, rerankConfidence: decision.confidence, rerankReason: decision.reason }
  }
}

export function createUsdaProviderIfConfigured(): UsdaProvider | null {
  if (!config.usda.apiKey) return null
  return new UsdaProvider()
}
