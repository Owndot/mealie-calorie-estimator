import type { FoodState, FoodRoute, ProviderMatch } from "../../types.js"

export interface ProviderQuery {
  /** Normalized English identity (LLM canonicalEnglish, or the raw structured name if the LLM is
   * unavailable) — primary query text for USDA/OFF, which work fine in English. Never originalText. */
  foodName: string
  /**
   * The raw structured Mealie food.name, before any LLM normalization/translation — still never
   * originalText. Always available even when the LLM is disabled/failed. Tried first by BLS
   * (highest-fidelity German text), and used as the ultimate fallback query by every provider.
   */
  structuredName?: string
  /**
   * Normalized German identity (LLM canonicalGerman) — BLS's primary query after structuredName
   * itself fails to match; catches misspellings/dialect/ambiguous wording the LLM cleaned up.
   * Absent when the LLM is disabled/failed (deterministic classification has no German normal form
   * beyond structuredName).
   */
  canonicalGerman?: string
  /** Evidence-based brand, null unless explicit structured evidence was found. */
  brand: string | null
  category: string | null
  state: FoodState
  /**
   * Which route this query is being resolved under. USDA uses this to exclude Branded results
   * outright on the generic route (never a correct generic-ingredient answer) while still
   * allowing a brand-compatible Branded result on the branded route, where OFF has priority
   * anyway. Optional/defaults to "generic" for any caller that predates this field.
   */
  route?: FoodRoute
}

export interface NutrientProvider {
  readonly name: string
  lookup(query: ProviderQuery): Promise<ProviderMatch | null>
}
