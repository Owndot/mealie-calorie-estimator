import { config } from "../../config.js"
import { logger } from "../../utils/logger.js"
import { waitForRateLimit, RateLimitType } from "../../utils/rate-limiter.js"
import { getCachedProviderMatch, setCachedProviderMatch, isProviderMiss, markProviderMiss, buildQueryKey } from "../../utils/cache.js"
import type { NutrientSet, ProviderMatch, FoodRoute, FoodType } from "../../types.js"
import type { NutrientProvider, ProviderQuery } from "./types.js"
import { rankCandidates, MIN_ACCEPTABLE_SCORE, inferStateFromName, type RankableCandidate } from "./ranking.js"

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
const USDA_MATCH_ALGORITHM_VERSION = "v6"

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
    const queryKey = buildQueryKey(`${USDA_MATCH_ALGORITHM_VERSION}:${query.foodName}|${query.state}|${route}`, query.brand)

    const cached = getCachedProviderMatch(this.name, queryKey)
    if (cached) return cached
    if (isProviderMiss(this.name, queryKey)) return null

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
      markProviderMiss(this.name, queryKey)
      return null
    }

    // Branded is excluded outright before ranking on the generic route — never a correct
    // generic-ingredient answer regardless of textual search score (the "banana" failure mode).
    const eligible = route === "generic" ? data.foods.filter((f) => f.dataType !== "Branded") : data.foods

    if (eligible.length === 0) {
      markProviderMiss(this.name, queryKey)
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
      dataTypeScore: (dt) => dataTypeScore(route, dt),
    })
    const top = ranked[0]

    if (!top) {
      markProviderMiss(this.name, queryKey)
      return null
    }

    // Checked before the score gate for the same reason off-provider.ts does: a mismatch always
    // drags the score below MIN_ACCEPTABLE_SCORE too, so checking score first would hide the
    // specific rejection reason behind a generic "no acceptable candidate" log.
    if (top.mismatchReason) {
      logger.info({ foodName: query.foodName, reason: top.mismatchReason }, "USDA: rejected obvious mismatch")
      markProviderMiss(this.name, queryKey)
      return null
    }

    if (top.score < MIN_ACCEPTABLE_SCORE) {
      logger.debug({ foodName: query.foodName, topScore: top.score }, "USDA: no acceptable candidate")
      markProviderMiss(this.name, queryKey)
      return null
    }

    const food = top.candidate.food
    const nutrients = extractNutrients(food)
    if (nutrients.kcalPer100g === null) {
      markProviderMiss(this.name, queryKey)
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
      confidence: Math.min(0.9, top.score / 100),
      dataType: food.dataType ?? null,
      foodType: usdaFoodType(food.foodCategory),
      matchReason: query.foodName.trim().toLowerCase() === food.description.trim().toLowerCase() ? "exact-name" : "fuzzy",
    }

    setCachedProviderMatch(this.name, queryKey, match)
    return match
  }
}

export function createUsdaProviderIfConfigured(): UsdaProvider | null {
  if (!config.usda.apiKey) return null
  return new UsdaProvider()
}
