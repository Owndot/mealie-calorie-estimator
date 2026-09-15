import { estimateNutrients } from "../llm-estimator.js"
import type { ProviderMatch } from "../../types.js"
import type { NutrientProvider, ProviderQuery } from "./types.js"

/**
 * LLM per-100g nutrient estimate — the final fallback tier, appended last on both the generic
 * and branded routes. This is scoped to a single food's nutrient estimate only (not a
 * classification call): it participates only after cache + generic/branded provider chains
 * have all failed to produce a sanity-checked match for that ingredient.
 */
export class LlmNutrientProvider implements NutrientProvider {
  // Matches the "llm-nutrient" FallbackStatus value — resolveNutrients uses provider.name
  // directly as the fallbackStatus, so these must stay in sync.
  readonly name = "llm-nutrient"

  async lookup(query: ProviderQuery): Promise<ProviderMatch | null> {
    const nutrients = await estimateNutrients(query.foodName)
    if (!nutrients) return null

    return {
      nutrients,
      canonicalName: query.foodName,
      brand: null,
      state: query.state,
      provider: this.name,
      providerId: null,
      productName: null,
      confidence: 0.35,
    }
  }
}

export const llmNutrientProvider = new LlmNutrientProvider()
