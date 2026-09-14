import { config } from "../../config.js"
import { offProvider } from "./off-provider.js"
import { createBlsProviderIfAvailable } from "./bls-provider.js"
import { createUsdaProviderIfConfigured } from "./usda-provider.js"
import { llmNutrientProvider } from "./llm-nutrient-provider.js"
import type { NutrientProvider } from "./types.js"
import type { FoodRoute } from "../../types.js"

/**
 * Builds the generic-route provider chain: BLS 4.0 (bundled local reference data, licensed
 * CC BY 4.0 — see resources/bls and README) first, then USDA FoodData Central if USDA_API_KEY is
 * configured, then Open Food Facts as an optional final database fallback (OFF is a real branded/
 * product database — a generic ingredient with no BLS or USDA match may still resolve there
 * before falling all the way to the LLM). There is no dummy/no-op entry for a provider that isn't
 * configured (USDA without a key) — it simply isn't in the list. BLS itself degrades the same way
 * if its bundled database is somehow missing at runtime (bls-provider.ts logs a warning and every
 * lookup returns null) rather than crashing — an honest "unresolved" beats a fabricated number.
 */
function buildGenericProviders(): NutrientProvider[] {
  const providers: NutrientProvider[] = [createBlsProviderIfAvailable()]
  const usda = createUsdaProviderIfConfigured()
  if (usda) providers.push(usda)
  providers.push(offProvider)
  return providers
}

/**
 * Branded route: Open Food Facts first (it's the branded/product-label database), then BLS,
 * then the same USDA fallback, for cases OFF can't resolve — a packaged/branded product that OFF
 * doesn't have may still exist as an unbranded BLS staple (e.g. a store-brand item BLS classifies
 * generically). OFF is never repeated after BLS/USDA — it already ran first.
 */
function buildBrandedProviders(): NutrientProvider[] {
  const providers: NutrientProvider[] = [offProvider, createBlsProviderIfAvailable()]
  const usda = createUsdaProviderIfConfigured()
  if (usda) providers.push(usda)
  return providers
}

/**
 * Routing-aware provider chain:
 *   generic:  cache → BLS → USDA (optional) → OFF (optional final DB fallback) → LLM last
 *   branded:  cache → OFF → BLS → USDA (optional) → LLM last
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
