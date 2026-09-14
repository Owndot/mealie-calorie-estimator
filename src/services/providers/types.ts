import type { FoodState, ProviderMatch } from "../../types.js"

export interface ProviderQuery {
  /** Structured/canonical food name (post-LLM-normalization, may be translated) — never originalText. */
  foodName: string
  /**
   * The raw structured Mealie food.name, before any LLM normalization/translation — still never
   * originalText. Used by BLS (a German-only database) as its primary match target, since the
   * batch normalizer may translate foodName to English. Optional so existing callers/tests that
   * only care about foodName (OFF/USDA, which work fine in either language) don't need updating.
   */
  structuredName?: string
  /** Evidence-based brand, null unless explicit structured evidence was found. */
  brand: string | null
  category: string | null
  state: FoodState
}

export interface NutrientProvider {
  readonly name: string
  lookup(query: ProviderQuery): Promise<ProviderMatch | null>
}
