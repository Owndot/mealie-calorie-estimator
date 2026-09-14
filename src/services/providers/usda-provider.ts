import { config } from "../../config.js"
import { logger } from "../../utils/logger.js"
import { waitForRateLimit, RateLimitType } from "../../utils/rate-limiter.js"
import { getCachedProviderMatch, setCachedProviderMatch, isProviderMiss, markProviderMiss, buildQueryKey } from "../../utils/cache.js"
import type { NutrientSet, ProviderMatch } from "../../types.js"
import type { NutrientProvider, ProviderQuery } from "./types.js"
import { rankCandidates, MIN_ACCEPTABLE_SCORE, type RankableCandidate } from "./ranking.js"

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
  foodNutrients: FdcNutrient[]
}

interface FdcSearchResult {
  foods: FdcFood[]
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504])

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
    // as every other provider (OFF, local-generic), so convert here at the provider boundary.
    sodiumPer100g: sodiumMg !== null ? sodiumMg / 1000 : null,
    cholesterolPer100g: cholesterolMg !== null ? cholesterolMg / 1000 : null,
  }
}

interface RankableFdcFood extends RankableCandidate {
  food: FdcFood
}

/**
 * USDA FoodData Central provider — a real, optional generic-route fallback. Only constructed
 * and added to the provider registry when USDA_API_KEY is configured; there is no dummy
 * placeholder occupying this slot when it's absent.
 */
export class UsdaProvider implements NutrientProvider {
  readonly name = "usda"

  async lookup(query: ProviderQuery): Promise<ProviderMatch | null> {
    const queryKey = buildQueryKey(query.foodName, query.brand)

    const cached = getCachedProviderMatch(this.name, queryKey)
    if (cached) return cached

    if (isProviderMiss(this.name, queryKey)) return null

    const params = new URLSearchParams({
      api_key: config.usda.apiKey,
      query: query.foodName,
      pageSize: "10",
      dataType: "Foundation,SR Legacy",
    })
    const url = `${config.usda.baseUrl}/foods/search?${params}`

    await waitForRateLimit(RateLimitType.Usda)
    const res = await fetchWithRetry(url)

    if (!res || !res.ok) {
      logger.debug({ foodName: query.foodName, status: res?.status }, "USDA search failed")
      return null
    }

    let data: FdcSearchResult
    try {
      data = (await res.json()) as FdcSearchResult
    } catch {
      return null
    }

    if (!data.foods || data.foods.length === 0) {
      markProviderMiss(this.name, queryKey)
      return null
    }

    const rankable: RankableFdcFood[] = data.foods.map((food) => ({
      food,
      name: food.description,
      brand: food.brandOwner ?? null,
      hasCompleteNutrients: findNutrient(food, NUTRIENT_IDS.energyKcal) != null,
    }))

    const ranked = rankCandidates(query.foodName, query.brand, rankable)
    const top = ranked[0]

    if (!top || top.score < MIN_ACCEPTABLE_SCORE || top.mismatchReason) {
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
      brand: food.brandOwner ?? query.brand,
      state: query.state,
      provider: this.name,
      providerId: String(food.fdcId),
      productName: food.description,
      confidence: Math.min(0.9, top.score / 100),
    }

    setCachedProviderMatch(this.name, queryKey, match)
    return match
  }
}

export function createUsdaProviderIfConfigured(): UsdaProvider | null {
  if (!config.usda.apiKey) return null
  return new UsdaProvider()
}
