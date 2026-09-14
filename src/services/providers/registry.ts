import { config } from "../../config.js"
import { localGenericProvider } from "./local-generic-provider.js"
import { offProvider } from "./off-provider.js"
import { createUsdaProviderIfConfigured } from "./usda-provider.js"
import { llmNutrientProvider } from "./llm-nutrient-provider.js"
import type { NutrientProvider } from "./types.js"
import type { FoodRoute } from "../../types.js"

/**
 * Builds the generic-route provider chain: local generic dataset first (always available),
 * then USDA only if USDA_API_KEY is configured. There is no dummy/no-op entry for providers
 * that aren't configured (e.g. BLS pending licensing) — they simply aren't in the list.
 */
function buildGenericProviders(): NutrientProvider[] {
  const providers: NutrientProvider[] = [localGenericProvider]
  // A licensed local dataset (BLS or otherwise), once cleared, would be added here via
  // config.bls.localImportPath. Intentionally not implemented/bundled — see config.ts.
  const usda = createUsdaProviderIfConfigured()
  if (usda) providers.push(usda)
  return providers
}

/**
 * Branded route: Open Food Facts first (it's the branded/product-label database), then the
 * same generic fallback chain for cases OFF can't resolve.
 */
function buildBrandedProviders(): NutrientProvider[] {
  return [offProvider, ...buildGenericProviders()]
}

/**
 * Routing-aware provider chain. OFF is never queried on the generic route — generic foods go
 * straight to the local/USDA generic tier. The LLM nutrient estimate is always last, on both
 * routes, and only included when LLM_ENABLED + LLM_API_KEY are set.
 */
export function getProviderChain(route: FoodRoute): NutrientProvider[] {
  const chain = route === "branded" ? buildBrandedProviders() : buildGenericProviders()
  if (config.llm.enabled && config.llm.apiKey) {
    return [...chain, llmNutrientProvider]
  }
  return chain
}
