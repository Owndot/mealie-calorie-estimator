import { config } from "../../config.js"
import { offProvider } from "./off-provider.js"
import { createUsdaProviderIfConfigured } from "./usda-provider.js"
import { llmNutrientProvider } from "./llm-nutrient-provider.js"
import type { NutrientProvider } from "./types.js"
import type { FoodRoute } from "../../types.js"

/**
 * Builds the generic-route provider chain: USDA FoodData Central only if USDA_API_KEY is
 * configured. There is no hand-authored local nutrition dataset here and no dummy/no-op entry
 * for a provider that isn't configured (e.g. BLS pending licensing, or USDA without a key) —
 * they simply aren't in the list. A local dataset may only carry deterministic unit/density/
 * piece-weight metadata (see food-density.ts) — it must never silently act as a trusted
 * nutrition source with hand-authored kcal/macros. Until a real (licensed or well-sourced)
 * local generic dataset is added, an unconfigured, LLM-disabled deployment genuinely resolves
 * no generic-route nutrition — that's intentional: an honest "unresolved" beats a fabricated
 * number.
 */
function buildGenericProviders(): NutrientProvider[] {
  const providers: NutrientProvider[] = []
  // A real licensed/sourced local dataset (BLS or otherwise), once cleared, would be added here
  // via config.bls.localImportPath. Intentionally not implemented/bundled — see config.ts.
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
 * straight to the USDA generic tier (when configured). The LLM nutrient estimate is always
 * last, on both routes, and only included when LLM_ENABLED + LLM_API_KEY are set.
 */
export function getProviderChain(route: FoodRoute): NutrientProvider[] {
  const chain = route === "branded" ? buildBrandedProviders() : buildGenericProviders()
  if (config.llm.enabled && config.llm.apiKey) {
    return [...chain, llmNutrientProvider]
  }
  return chain
}
