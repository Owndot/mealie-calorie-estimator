import { config } from "../../config.js"
import { offProvider } from "./off-provider.js"
import { createBlsProviderIfAvailable } from "./bls-provider.js"
import { usdaLocalProvider } from "./usda-local-provider.js"
import { llmNutrientProvider } from "./llm-nutrient-provider.js"
import { mealieRecipeProvider } from "./mealie-recipe-provider.js"
import { overrideProvider } from "./override-provider.js"
import type { NutrientProvider } from "./types.js"
import type { FoodRoute } from "../../types.js"

/**
 * Builds the generic-route provider chain. The user's OWN Mealie recipes come first — a homemade
 * paste or spice mix is the one food no public database can know — followed by BLS 4.0 (bundled
 * local reference data, licensed
 * CC BY 4.0 — see resources/bls and README), then the bundled USDA FoodData Central generic
 * database, then Open Food Facts.
 *
 * USDA precedes OFF here because it is a generic-food database being asked a generic question,
 * while OFF is branded product-label data. Both are bundled-or-degraded rather than optional: a
 * provider whose resource is missing logs a warning and returns null for every lookup rather than
 * crashing or reaching for a network fallback — an honest "unresolved" beats a fabricated number.
 */
function buildGenericProviders(): NutrientProvider[] {
  // The user's own recipes come first on both routes: a homemade paste or spice mix is the one
  // food no public database can know, and the provider only ever answers on an exact recipe-name
  // match, so it is silent for every ordinary ingredient.
  //
  // A user-confirmed override comes second — after the recipes, before everything automatic. It
  // settles what automatic resolution could not; a Mealie recipe is not automatic resolution, and
  // letting a static pointer shadow a live recipe would make editing that recipe ineffective.
  // Both are silent unless they have something for this exact ingredient.
  return [mealieRecipeProvider, overrideProvider, createBlsProviderIfAvailable(), usdaLocalProvider, offProvider]
}

/**
 * Branded route: Open Food Facts first (it's the branded/product-label database), then BLS,
 * then the same USDA fallback, for cases OFF can't resolve — a packaged/branded product that OFF
 * doesn't have may still exist as an unbranded BLS staple (e.g. a store-brand item BLS classifies
 * generically). OFF is never repeated after BLS/USDA — it already ran first.
 */
function buildBrandedProviders(): NutrientProvider[] {
  return [mealieRecipeProvider, overrideProvider, offProvider, createBlsProviderIfAvailable(), usdaLocalProvider]
}

/**
 * Routing-aware provider chain:
 *   generic:  cache → own recipes → BLS → OFF → USDA (optional) → LLM last
 *   branded:  cache → own recipes → OFF → BLS → USDA (optional) → LLM last
 * (each provider checks its own cache first internally). The LLM nutrient estimate is always
 * last, on both routes, and only included when LLM_ENABLED + LLM_API_KEY are set — direct LLM
 * nutrient estimation is the absolute last resort, never a substitute for a real database match.
 */
export function getProviderChain(route: FoodRoute): NutrientProvider[] {
  const chain = route === "branded" ? buildBrandedProviders() : buildGenericProviders()
  if (config.llm.enabled && config.llm.apiKey) {
    return [...chain, llmNutrientProvider]
  }
  return chain
}
