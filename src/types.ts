export interface MealieIngredient {
  quantity: number | null
  unit: MealieUnit | null
  food: MealieFood | null
  note: string | null
  display: string
  title: string | null
  originalText: string | null
  referenceId?: string | null
}

export interface MealieUnit {
  id: string
  name: string
  pluralName: string | null
  abbreviation: string | null
  standardQuantity: number | null
  standardUnit: string | null
}

export interface MealieFood {
  id: string
  name: string
  pluralName: string | null
  aliases: string[]
}

export interface MealieNutrition {
  calories: string | null
  carbohydrateContent: string | null
  cholesterolContent: string | null
  fatContent: string | null
  fiberContent: string | null
  proteinContent: string | null
  saturatedFatContent: string | null
  sodiumContent: string | null
  sugarContent: string | null
  transFatContent: string | null
  unsaturatedFatContent: string | null
}

export interface MealieTag {
  id: string
  name: string
  slug: string
  groupId: string | null
}

export interface MealieRecipe {
  slug: string
  name: string
  recipeYield: string | null
  recipeServings: number | null
  recipeIngredient: MealieIngredient[]
  nutrition: MealieNutrition | null
  tags: MealieTag[] | null
  extras: Record<string, string> | null
  householdId?: string | null
  household_id?: string | null
}

export interface MealieRecipePatch {
  nutrition?: Partial<MealieNutrition>
  extras?: Record<string, string>
  tags?: MealieTag[]
}

export interface OffSearchResult {
  hits: OffProduct[]
  count?: number
  page?: number
  page_count?: number
  page_size?: number
}

export interface OffProduct {
  product_name: string
  // The real search-a-licious /search API returns this as a string array (e.g.
  // ["Nutella","Ferrero"], sometimes with empty-string elements) — verified against a live
  // response. Typed loosely here since it's untrusted external data; off-provider.ts normalizes
  // it defensively rather than trusting either shape at runtime.
  brands?: string[] | string | null
  nutriscore_grade?: string
  /** OFF's own taxonomy tags (e.g. "en:meals", "en:vegetables") — untrusted external data, typed loosely. */
  categories_tags?: unknown
  nutriments?: OffNutriments
}

export interface OffNutriments {
  "energy-kcal_100g": number | null
  "proteins_100g": number | null
  "carbohydrates_100g": number | null
  "fat_100g": number | null
  "saturated-fat_100g": number | null
  "trans-fat_100g": number | null
  "fiber_100g": number | null
  "sugars_100g": number | null
  "sodium_100g": number | null
  "cholesterol_100g": number | null
}

export interface AppriseWebhookPayload {
  title: string
  body: string
  event_type: string
  document_data?: string
  event_id?: string
  timestamp?: string
}

export interface EventRecipeData {
  document_type: string
  documentType?: string
  operation: string
  recipe_slug: string
  recipeSlug?: string
}

export interface NutrientSet {
  kcalPer100g: number | null
  proteinPer100g: number | null
  carbsPer100g: number | null
  fatPer100g: number | null
  saturatedFatPer100g: number | null
  transFatPer100g: number | null
  unsaturatedFatPer100g: number | null
  fiberPer100g: number | null
  sugarPer100g: number | null
  sodiumPer100g: number | null
  cholesterolPer100g: number | null
}

/** Preparation state of a resolved food, used for provider matching only — never derived from originalText. */
export type FoodState = "raw" | "cooked" | "dried" | "unknown"

/** Which side of the routing split an ingredient was classified into. Branded requires explicit structured evidence. */
export type FoodRoute = "generic" | "branded"

/**
 * Coarse food-composition type — the PRIMARY signal for rejecting a semantically-wrong candidate
 * before any lexical/confidence scoring runs (a high text-similarity score must never rescue a
 * type mismatch). "unknown" is permissive (never itself causes a rejection) — used when the LLM
 * is disabled/failed and no authoritative signal is available.
 *   simple:                  a single raw/minimally-prepared ingredient (tomato, salt, egg, oil)
 *   processed_single_food:   one food that's been processed but is still one thing, not a dish
 *                            (tomato paste, canned tuna, cheese, dried herbs, spice powder)
 *   composite_dish:          a prepared dish/menu component with multiple ingredients (lentil
 *                            soup, stuffed pepper, a stew, a dessert)
 */
export type FoodType = "simple" | "processed_single_food" | "composite_dish" | "unknown"

/**
 * Evidence-based classification of one structured ingredient, produced by the single
 * whole-recipe batch normalizer (or by deterministic fallback when the batch fails or LLM is disabled).
 * brand is non-null only when explicit evidence for it was present in structured food.name/aliases.
 * canonicalGerman/canonicalEnglish are normalized *identities* for provider matching, not nutrient
 * calculations — the LLM understands the ingredient here, it never estimates nutrients at this
 * stage. Both must preserve nutritionally-relevant qualifiers the deterministic fallback already
 * had (raw/cooked/dried/canned/drained/lean/fat%/...) — translation must not silently drop them.
 */
export interface IngredientClassification {
  index: number
  /** Normalized German identity — BLS's primary query text (after the raw structured name itself). */
  canonicalGerman: string
  /** Normalized/translated English identity — USDA/OFF's primary query text. */
  canonicalEnglish: string
  brand: string | null
  state: FoodState
  category: string | null
  /** "unknown" (never simple/processed by default) when the LLM is disabled/failed — see FoodType. */
  foodType: FoodType
  /**
   * The base food-identity noun within canonicalGerman, stripped of modifiers (color, origin/
   * style, state) — e.g. "Zwiebel" for "rote Zwiebel", "Gewürzmischung" for "italienische
   * Gewürzmischung". Used as a PRIMARY hard-rejection signal by BLS: a candidate whose name
   * contains none of this word's tokens is a different food regardless of shared adjectives — see
   * ranking.ts's coreIdentityConflict(). Null when the LLM is disabled/failed (permissive, same
   * degrade pattern as foodType "unknown") or genuinely unclear.
   */
  coreFoodGerman: string | null
  /** Same as coreFoodGerman, in English (e.g. "onion", "seasoning") — used by OFF/USDA. */
  coreFoodEnglish: string | null
  route: FoodRoute
  /** true when the LLM batch normalizer actually produced this row (vs. deterministic fallback) */
  llmClassified: boolean
}

export type FallbackStatus = "bls" | "usda" | "off" | "llm-nutrient" | "unresolved"

export interface ProviderMatch {
  nutrients: NutrientSet
  canonicalName: string
  brand: string | null
  state: FoodState
  provider: string
  providerId: string | null
  productName: string | null
  /** 0..1, provider-reported confidence in this being the right match */
  confidence: number
  /** USDA FoodData Central dataset tier (Foundation/SR Legacy/Survey (FNDDS)/Branded) — null for non-USDA providers. */
  dataType?: string | null
  /** The matched candidate's own food type (BLS's group-letter-derived type, or USDA's foodCategory-derived type) — for provenance/debugging, not itself a query field. */
  foodType?: FoodType
  /** Short, human-readable reason the match was accepted — e.g. "exact-name", "synonym", "state-compatible", "category-compatible", "fuzzy". */
  matchReason?: string
}

export interface IngredientMatch {
  name: string
  canonicalName: string | null
  brand: string | null
  route: FoodRoute | null
  grams: number | null
  gramsEstimated: boolean
  matched: boolean
  nutrients: NutrientSet | null
  provider: string | null
  providerId: string | null
  /** The matched provider record's own name (e.g. BLS's "Speisezwiebel roh"), distinct from `canonicalName` (the query). */
  productName: string | null
  confidence: number | null
  fallbackStatus: FallbackStatus
  llmParticipated: boolean
  /** USDA dataset tier for this match, when the provider was "usda" — null otherwise. */
  dataType?: string | null
  /** The matched candidate's own food type — see ProviderMatch.foodType. */
  foodType?: FoodType
  /** Short, human-readable reason the match was accepted — see ProviderMatch.matchReason. */
  matchReason?: string
  /** @deprecated use fallbackStatus === "unresolved" ? gramsEstimated via LLM : false */
  llmEstimated?: boolean
}

export type Completeness = "complete" | "partial" | "withheld"

export interface EstimateResult {
  slug: string
  servings: number | null
  totalNutrients: NutrientSet
  perServingNutrients: NutrientSet
  matchedCount: number
  unmatchedCount: number
  unmatchedIngredients: string[]
  matchedIngredients: IngredientMatch[]
  completeness: Completeness
  completenessReason: string | null
}

export interface NutritionPatch {
  /**
   * Omit this field entirely (not `{}`) to leave Mealie's nutrition untouched. Confirmed live:
   * Mealie's recipe PATCH treats `nutrition` as an atomic sub-object — including the key at all,
   * even as `{}`, REPLACES every field with what's provided (unmentioned fields become null).
   * Only actually omitting the key from the JSON body preserves the existing value.
   */
  nutrition?: Partial<MealieNutrition>
  extras: Record<string, string>
}
