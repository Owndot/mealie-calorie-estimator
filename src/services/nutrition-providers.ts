import { config } from "../config.js"
import type { IngredientMatch, NutrientSet } from "../types.js"
import { getCachedResolvedFood, setCachedResolvedFood, type CachedResolvedFood } from "../utils/cache.js"
import { logger } from "../utils/logger.js"
import { contextForName, nutrientCacheKey, type IngredientContext } from "./ingredient-context.js"
import { genericNutrients, matchGenericFood } from "./generic-foods.js"
import { lookupNutrients } from "./off-client.js"
import { estimateNutrients } from "./llm-estimator.js"
import { validateCompleteProfile, validateProfile } from "./nutrition-validation.js"

export interface ResolvedNutrition {
  nutrients: NutrientSet
  source: NonNullable<IngredientMatch["source"]>
  originalSource?: string
  confidence: number
  timestamp: number
  productName: string | null
  profileId?: string
  reason: string
}
/** Providers return a validated per-100-g profile, never ingredient or serving totals. */
export interface NutritionProvider {
  name: string
  resolve(context: IngredientContext): Promise<ResolvedNutrition | null>
}
function cacheKey(context: IngredientContext): string {
  return JSON.stringify(["resolved-v1", nutrientCacheKey("off", context), context.query,
    config.openFoodFacts.searchBaseUrl, config.openFoodFacts.language,
    config.llm.enabled, config.llm.baseUrl, config.llm.endpointUrl, config.llm.model])
}
export class LocalCacheProvider implements NutritionProvider {
  name = "local-cache"
  async resolve(context: IngredientContext): Promise<ResolvedNutrition | null> {
    const value = getCachedResolvedFood(cacheKey(context))
    if (!value || !value.nutrients || validateProfile(value.nutrients).length
      || !Number.isFinite(value.confidence) || value.confidence <= 0 || value.confidence > 1
      || !["OFF", "generic", "deterministic", "LLM"].includes(value.source)
      || (value.source === "LLM" && validateCompleteProfile(value.nutrients).length)) return null
    return { ...value, source: "local-cache", originalSource: value.source, reason: `cached ${value.source} profile; original confidence retained` }
  }
}
export class OpenFoodFactsProvider implements NutritionProvider {
  name = "openfoodfacts"
  async resolve(context: IngredientContext): Promise<ResolvedNutrition | null> {
    if (context.generic === true && !context.brand) return null
    if (context.reason.startsWith("safe unresolved")) return null
    const result = await lookupNutrients(context.query, undefined, context)
    if (!result.matched || !result.nutrients) return null
    return { nutrients: result.nutrients, source: "OFF", confidence: result.confidence === "high" ? 0.95 : 0.8,
      timestamp: Date.now(), productName: result.productName, reason: result.reason ?? "OFF match" }
  }
}
export class GenericFoodProvider implements NutritionProvider {
  name = "generic-food-database"
  async resolve(context: IngredientContext): Promise<ResolvedNutrition | null> {
    if (context.compoundNames?.length) {
      const profiles = context.compoundNames.map(name => genericNutrients(contextForName(name)))
      if (profiles.every((profile): profile is NutrientSet => profile !== null)) {
        const nutrients = Object.fromEntries((Object.keys(profiles[0]) as Array<keyof NutrientSet>).map(key =>
          [key, profiles.some(profile => profile[key] === null) ? null : profiles.reduce((sum, profile) => sum + profile[key]!, 0) / profiles.length])) as unknown as NutrientSet
        return { nutrients, source: "generic", confidence: 0.65, timestamp: Date.now(), productName: null,
          reason: "compound seasoning: estimated equal proportions of trusted generic components" }
      }
      return null
    }
    const nutrients = genericNutrients(context)
    if (!nutrients || (context.fatPercentage != null && nutrients.fatPer100g != null
      && Math.abs(nutrients.fatPer100g - context.fatPercentage) > Math.max(1.5, context.fatPercentage * 0.25))) return null
    const match = matchGenericFood(context)
    const deterministic = ["salt", "water"].includes(context.canonicalName) && context.state === "unspecified"
    return { nutrients, source: deterministic ? "deterministic" : "generic",
      confidence: deterministic ? 1 : match ? Math.min(0.95, match.confidence) : 0.9,
      timestamp: Date.now(), productName: match?.entry.description ?? null, profileId: match?.entry.fdcId,
      reason: "validated generic identity/state; USDA reference preferred before OFF for generic foods" }
  }
}
export class LLMFallbackProvider implements NutritionProvider {
  name = "llm-estimate"
  async resolve(context: IngredientContext): Promise<ResolvedNutrition | null> {
    logger.warn({ food: context.query }, "No database match; attempting LLM nutrient fallback")
    const nutrients = await estimateNutrients(context.query, context)
    if (!nutrients || validateCompleteProfile(nutrients).length) return null
    return { nutrients, source: "LLM", confidence: 0.6, timestamp: Date.now(), productName: null,
      reason: "validated LLM nutrient fallback" }
  }
}
export function defaultProviders(): NutritionProvider[] {
  return [new LocalCacheProvider(), new OpenFoodFactsProvider(), new GenericFoodProvider(), new LLMFallbackProvider()]
}
export async function resolveNutrition(context: IngredientContext, providers = defaultProviders()): Promise<ResolvedNutrition | null> {
  for (const provider of providers) {
    let result: ResolvedNutrition | null
    try {
      result = await provider.resolve(context)
      if (!result || validateProfile(result.nutrients).length) continue
    } catch (error) {
      logger.warn({ error, food: context.query, provider: provider.name }, "Nutrition provider failed; trying next source")
      continue
    }
    if (result.source !== "local-cache") {
      const cached: CachedResolvedFood = { normalizedName: context.canonicalName, aliases: [context.originalName, context.query],
        nutrients: result.nutrients, source: result.source, confidence: result.confidence,
        timestamp: result.timestamp, productName: result.productName, profileId: result.profileId }
      try { setCachedResolvedFood(cacheKey(context), cached) } catch (error) {
        logger.warn({ error }, "Unable to cache resolved food; using valid profile")
      }
    }
    return result
  }
  return null
}
