import { validateCompleteProfile, validateProfile } from "./nutrition-validation.js"
import { scoreOffMatch } from "./off-matching.js"
import { contextForName, nutrientCacheKey, type IngredientContext } from "./ingredient-context.js"
import { knownGramsPerUnit } from "./generic-foods.js"
import { config } from "../config.js"
import { logger } from "../utils/logger.js"
import { getCachedOffLookup, setCachedOffLookup } from "../utils/cache.js"
import { waitForRateLimit, RateLimitType } from "../utils/rate-limiter.js"
import type { OffNutriments, OffProduct, OffSearchResult, NutrientSet } from "../types.js"

export interface OffLookupResult {
  nutrients: NutrientSet | null
  matched: boolean
  productName: string | null
  confidence?: "high" | "medium"
  reason?: string
}

function validateOffNutrients(nutrients: NutrientSet, context: IngredientContext): string[] {
  const reasons = validateCompleteProfile(nutrients)
  if (nutrients.kcalPer100g === 0 && !["salt", "water"].includes(context.canonicalName)) {
    reasons.push("zero energy for non-zero-energy food")
  }
  return [...new Set(reasons)]
}

const OFF_NUTRIENT_FIELDS = ["product_name", "nutriments", "brands", "categories_tags", "nutrition_data_per"].join(",")

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504])

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
      const res = await fetch(url, { headers: { "User-Agent": userAgent }, signal: AbortSignal.timeout(15000) })
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
    sodiumPer100g: n["sodium_100g"] != null ? n["sodium_100g"] * 1000 : n["salt_100g"] != null ? n["salt_100g"] / 2.5 * 1000 : null,
    cholesterolPer100g: n["cholesterol_100g"] != null ? n["cholesterol_100g"] * 1000 : null,
  }
}

async function searchProduct(query: string): Promise<OffProduct[]> {
  const params = new URLSearchParams({
    q: query,
    langs: config.openFoodFacts.language,
    page_size: "10",
    fields: OFF_NUTRIENT_FIELDS,
  })

  const url = `${config.openFoodFacts.searchBaseUrl}/search?${params}`

  await waitForRateLimit(RateLimitType.Search)

  const res = await fetchWithRetry(url, query)

  if (!res) {
    logger.warn({ query }, "OFF search failed after retries")
    return []
  }

  if (!res.ok) {
    logger.warn({ status: res.status, query }, "OFF search returned error")
    return []
  }

  let data: OffSearchResult
  try {
    data = (await res.json()) as OffSearchResult
  } catch {
    logger.warn({ query }, "OFF returned non-JSON response")
    return []
  }

  if (!Array.isArray(data.hits) || data.hits.length === 0) {
    return []
  }

  return data.hits.slice(0, 10)
}

export async function lookupNutrients(foodName: string, unitName?: string, suppliedContext?: IngredientContext): Promise<OffLookupResult> {
  let searchTerm = foodName.trim()
  if (unitName && searchTerm.toLowerCase().startsWith(`${unitName.toLowerCase()} `)) searchTerm = searchTerm.slice(unitName.length).trim()
  const context = suppliedContext ?? contextForName(searchTerm)
  if (context.state === "ambiguous") return { nutrients: null, matched: false, productName: null, reason: context.reason }
  const cacheKey = nutrientCacheKey("off", context)
  const cached = getCachedOffLookup(cacheKey)
  if (cached && validateOffNutrients(cached.nutrients, context).length === 0) {
    return { ...cached, matched: true, reason: "validated state-specific OFF cache" }
  }
  const products = await searchProduct(suppliedContext ? context.query : searchTerm)
  const candidates: Array<{ nutrients: NutrientSet; product: OffProduct; score: number }> = []
  for (const product of products) {
    if (!product || !product.nutriments || typeof product.product_name !== "string") continue
    const nutrients = extractNutrients(product.nutriments)
    if (product.nutrition_data_per === "100ml") {
      const density = knownGramsPerUnit(context, "milliliter")
      if (density === null) continue // Cannot apply per-volume values to a mass without density.
      for (const key of Object.keys(nutrients) as Array<keyof NutrientSet>) {
        if (nutrients[key] !== null) nutrients[key] = nutrients[key]! / density
      }
    }
    const reasons = validateOffNutrients(nutrients, context)
    const identityScore = reasons.length ? 0 : scoreOffMatch(context, product.product_name, nutrients, product.brands)
    const categoryTokens: Record<string, string[]> = { dairy: ["dairies", "milks", "cheeses"], oil: ["oils"],
      grain: ["cereals", "pastas", "rices"], vegetable: ["vegetables"], fruit: ["fruits"], sauce: ["sauces"], spice: ["spices"], legume: ["legumes", "pulses"] }
    const tags = Array.isArray(product.categories_tags) ? product.categories_tags.filter(t => typeof t === "string") : []
    const categoryMatch = (categoryTokens[context.category ?? ""] ?? []).some(token => tags.some(tag => tag.includes(token)))
    const completeness = Object.values(nutrients).filter(value => value !== null).length / Object.keys(nutrients).length
    const score = identityScore ? identityScore + (categoryMatch ? 2 : 0) + completeness : 0
    logger.debug({ query: context.query, productName: product.product_name, score, reasons }, "Scored OFF candidate")
    if (score >= 80) candidates.push({ nutrients, product, score })
  }
  candidates.sort((a, b) => b.score - a.score)
  const best = candidates[0]
  if (!best) return { nutrients: null, matched: false, productName: null, reason: "no trustworthy OFF candidate" }
  setCachedOffLookup(cacheKey, { nutrients: best.nutrients, productName: best.product.product_name, confidence: best.score >= 100 ? "high" : "medium" })
  return { nutrients: best.nutrients, matched: true, productName: best.product.product_name, confidence: best.score >= 100 ? "high" : "medium", reason: "identity, state and nutrient validation passed" }
}
