import type { FoodState, ProviderMatch } from "../../types.js"

export interface ProviderQuery {
  /** Structured/canonical food name — never originalText. */
  foodName: string
  /** Evidence-based brand, null unless explicit structured evidence was found. */
  brand: string | null
  category: string | null
  state: FoodState
}

export interface NutrientProvider {
  readonly name: string
  lookup(query: ProviderQuery): Promise<ProviderMatch | null>
}
