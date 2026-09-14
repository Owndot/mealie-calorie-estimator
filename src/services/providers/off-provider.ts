import { config } from "../../config.js"
import { logger } from "../../utils/logger.js"
import { waitForRateLimit, RateLimitType } from "../../utils/rate-limiter.js"
import { getCachedProviderMatch, setCachedProviderMatch, isProviderMiss, markProviderMiss, buildQueryKey } from "../../utils/cache.js"
import type { OffNutriments, OffProduct, OffSearchResult, NutrientSet, ProviderMatch } from "../../types.js"
import type { NutrientProvider, ProviderQuery } from "./types.js"
import { rankCandidates, MIN_ACCEPTABLE_SCORE, type RankableCandidate } from "./ranking.js"

const OFF_FIELDS = ["product_name", "brands", "nutriments"].join(",")
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504])
const SEARCH_PAGE_SIZE = 10

async function fetchWithRetry(url: string, query: string): Promise<Response | null> {
  const { maxRetries, retryBackoffMs, userAgent } = config.openFoodFacts
  let lastResponse: Response | null = null

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const delay = retryBackoffMs * 2 ** (attempt - 1)
      logger.debug({ query, attempt, delay }, "Retrying OFF search after backoff")
      await new Promise((resolve) => setTimeout(resolve, delay))
    }

    try {
      const res = await fetch(url, { headers: { "User-Agent": userAgent } })
      if (res.ok || !RETRYABLE_STATUS.has(res.status)) {
        return res
      }
      lastResponse = res
      logger.debug({ query, attempt, status: res.status }, "OFF search returned retryable status")
    } catch (err) {
      lastResponse = null
      logger.debug({ query, attempt, err: (err as Error).message }, "OFF search request failed")
    }
  }

  return lastResponse
}

/**
 * Normalizes OFF's `brands` field to a single string or null, regardless of which real-world
 * shape it arrives in. Found live: the /search API actually returns a string array (sometimes
 * with empty-string elements, e.g. ["ja!", ""]), not the single string our type used to assume
 * — that mismatch crashed ranking's tokenize() on every real OFF candidate (`s.toLowerCase is
 * not a function`), silently falling through to the LLM fallback for every branded lookup.
 * This is untrusted external API data — normalize defensively rather than trusting the type.
 */
function normalizeOffBrand(brands: unknown): string | null {
  if (Array.isArray(brands)) {
    const joined = brands.filter((b): b is string => typeof b === "string" && b.trim().length > 0).join(", ")
    return joined.length > 0 ? joined : null
  }
  if (typeof brands === "string" && brands.trim().length > 0) return brands
  return null
}

function extractNutrients(n: OffNutriments): NutrientSet {
  const fat = n["fat_100g"] ?? null
  const saturated = n["saturated-fat_100g"] ?? null
  const trans = n["trans-fat_100g"] ?? null

  let unsaturated: number | null = null
  if (fat !== null) {
    const s = saturated ?? 0
    const t = trans ?? 0
    unsaturated = Math.round((fat - s - t) * 10) / 10
  }

  return {
    kcalPer100g: n["energy-kcal_100g"] ?? null,
    proteinPer100g: n["proteins_100g"] ?? null,
    carbsPer100g: n["carbohydrates_100g"] ?? null,
    fatPer100g: fat,
    saturatedFatPer100g: saturated,
    transFatPer100g: trans,
    unsaturatedFatPer100g: unsaturated,
    fiberPer100g: n["fiber_100g"] ?? null,
    sugarPer100g: n["sugars_100g"] ?? null,
    sodiumPer100g: n["sodium_100g"] ?? null,
    cholesterolPer100g: n["cholesterol_100g"] ?? null,
  }
}

/**
 * Returns null when the search itself couldn't be completed (network/HTTP/parse failure) —
 * distinct from an empty array, which means OFF was reached and genuinely has no hits. Callers
 * must only cache a negative result (markProviderMiss) for a confirmed empty array; caching a
 * transient failure as a miss would poison the negative cache for a full TTL window (up to a
 * day) every time OFF has a rate-limit flood or blip, silently starving unrelated foods of
 * branded nutrition long after OFF recovers.
 */
async function searchCandidates(query: string): Promise<OffProduct[] | null> {
  const params = new URLSearchParams({
    q: query,
    langs: config.openFoodFacts.language,
    page_size: String(SEARCH_PAGE_SIZE),
    fields: OFF_FIELDS,
  })

  const url = `${config.openFoodFacts.searchBaseUrl}/search?${params}`

  await waitForRateLimit(RateLimitType.Search)

  const res = await fetchWithRetry(url, query)

  if (!res) {
    logger.warn({ query }, "OFF search failed after retries")
    return null
  }

  if (!res.ok) {
    logger.warn({ status: res.status, query }, "OFF search returned error")
    return null
  }

  let data: OffSearchResult
  try {
    data = (await res.json()) as OffSearchResult
  } catch {
    logger.warn({ query }, "OFF returned non-JSON response")
    return null
  }

  return data.hits ?? []
}

interface RankableOffProduct extends RankableCandidate {
  product: OffProduct
}

/**
 * Open Food Facts provider. Used on the branded route (and as a generic-route fallback when
 * routing allows it). Never accepts the first search hit blindly — ranks all candidates by
 * name/brand similarity and nutrient completeness, and rejects curated obvious mismatches
 * (ginger vs ginger ale, salt vs electrolyte drink, etc).
 */
export class OffProvider implements NutrientProvider {
  readonly name = "off"

  async lookup(query: ProviderQuery): Promise<ProviderMatch | null> {
    const queryKey = buildQueryKey(query.foodName, query.brand)

    const cached = getCachedProviderMatch(this.name, queryKey)
    if (cached) {
      logger.debug({ foodName: query.foodName }, "OFF provider cache hit")
      return cached
    }

    if (isProviderMiss(this.name, queryKey)) {
      logger.debug({ foodName: query.foodName }, "OFF provider known-miss, skipping network call")
      return null
    }

    const searchTerm = query.brand ? `${query.brand} ${query.foodName}` : query.foodName
    const hits = await searchCandidates(searchTerm)

    // null = transient failure (network/HTTP/parse) — unknown, not a confirmed miss, so it must
    // never poison the negative cache. Only a confirmed empty array is a real miss.
    if (hits === null) return null

    if (hits.length === 0) {
      markProviderMiss(this.name, queryKey)
      return null
    }

    const rankable: RankableOffProduct[] = hits.map((product) => ({
      product,
      name: typeof product.product_name === "string" ? product.product_name : "",
      brand: normalizeOffBrand(product.brands),
      hasCompleteNutrients: product.nutriments?.["energy-kcal_100g"] != null,
    }))

    // categoryConflict participates here too (query-side data only — no new OFF response field
    // needed) for the same reason BLS/USDA reject it: a strict raw-ingredient category query
    // should never accept an OFF product that reads as a composite/manufactured item.
    const ranked = rankCandidates(query.foodName, query.brand, rankable, { queryCategory: query.category })
    const top = ranked[0]

    if (!top) {
      logger.debug({ foodName: query.foodName }, "OFF: no acceptable candidate")
      markProviderMiss(this.name, queryKey)
      return null
    }

    // Checked before the score gate: a mismatch always drags the score below
    // MIN_ACCEPTABLE_SCORE too, so checking score first would make this branch unreachable and
    // hide the specific "obvious mismatch" reason behind a generic "no acceptable candidate" log.
    if (top.mismatchReason) {
      logger.info({ foodName: query.foodName, reason: top.mismatchReason }, "OFF: rejected obvious mismatch")
      markProviderMiss(this.name, queryKey)
      return null
    }

    if (top.score < MIN_ACCEPTABLE_SCORE) {
      logger.debug({ foodName: query.foodName, topScore: top.score }, "OFF: no acceptable candidate")
      markProviderMiss(this.name, queryKey)
      return null
    }

    const product = top.candidate.product
    if (!product.nutriments || product.nutriments["energy-kcal_100g"] == null) {
      markProviderMiss(this.name, queryKey)
      return null
    }

    const match: ProviderMatch = {
      nutrients: extractNutrients(product.nutriments),
      canonicalName: query.foodName,
      brand: normalizeOffBrand(product.brands) ?? query.brand,
      state: query.state,
      provider: this.name,
      providerId: typeof product.product_name === "string" ? product.product_name : null,
      productName: typeof product.product_name === "string" ? product.product_name : null,
      confidence: Math.min(0.95, top.score / 100),
    }

    setCachedProviderMatch(this.name, queryKey, match)
    return match
  }
}

export const offProvider = new OffProvider()
