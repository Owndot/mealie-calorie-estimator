import type { FoodState, FoodRoute, FoodType, ProviderMatch } from "../../types.js"
import type { IdentityEvidence } from "../identity-evidence.js"
import type { FoodAttributes } from "../../types.js"

export interface ProviderQuery {
  /**
   * Nutritionally meaningful form/preservation/fat attributes. Participate in candidate validation
   * (formConflict/preservationConflict/fatConflict) and in cache identity, so a cached "ground
   * ginger" can never be served to a "fresh ginger" query. "unknown" values stay permissive.
   */
  attributes?: FoodAttributes
  /**
   * What is actually KNOWN about this ingredient's identity. Absent evidence must make a provider
   * stricter, never more permissive — see identity-evidence.ts. Optional so existing callers and
   * tests keep working; treated as FULL_EVIDENCE when omitted.
   */
  evidence?: IdentityEvidence
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
   * The PRIMARY hard-rejection signal (see FoodType): a "simple"/"processed_single_food" query
   * must never accept a "composite_dish" candidate, regardless of lexical score. "unknown" is
   * permissive — never itself causes a rejection (used when the LLM is disabled/failed).
   */
  foodType: FoodType
  /**
   * The query's core food-identity noun in German (e.g. "Zwiebel" for "rote Zwiebel",
   * "Gewürzmischung" for "italienische Gewürzmischung") — from the LLM's coreFoodGerman
   * classification. A SECOND primary hard-rejection signal alongside foodType, used by BLS: a
   * candidate whose name contains none of this word's tokens is a different food regardless of
   * shared adjectives. See ranking.ts's coreIdentityConflict(). Null/absent is permissive.
   */
  coreFoodGerman?: string | null
  /** Same as coreFoodGerman, in English (e.g. "onion", "seasoning") — used by OFF/USDA. */
  coreFoodEnglish?: string | null
  /**
   * Which route this query is being resolved under. USDA uses this to exclude Branded results
   * outright on the generic route (never a correct generic-ingredient answer) while still
   * allowing a brand-compatible Branded result on the branded route, where OFF has priority
   * anyway. Optional/defaults to "generic" for any caller that predates this field.
   */
  route?: FoodRoute
  /** Which Mealie household this recipe belongs to — the recipe source reads through the same token. */
  householdId?: string | null
  /**
   * Slugs of the recipes already being resolved, outermost first. The mealie-recipe provider
   * refuses to resolve through any of them, which is what makes a dependency cycle impossible
   * rather than merely unlikely.
   */
  ancestorSlugs?: string[]
}

export interface NutrientProvider {
  readonly name: string
  lookup(query: ProviderQuery): Promise<ProviderMatch | null>
}
