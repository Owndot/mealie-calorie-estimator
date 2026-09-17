import { evidenceFor } from "./identity-evidence.js"
import { UNKNOWN_ATTRIBUTES, type FoodRoute, type FoodState, type IngredientClassification } from "../types.js"
import type { ProviderQuery } from "./providers/types.js"

/**
 * Turns one classified ingredient into the query the resolver actually receives.
 *
 * Extracted because there was a second, incomplete copy of this: the override-preview endpoint
 * assembled its own query and left `coreFoodGerman` null, so BLS could not match and preview
 * reported "lean ground beef resolves to a 250 kcal LLM estimate" while production was resolving
 * it to BLS's 224 kcal record. A preview that does not reproduce production is worse than no
 * preview — someone binds an override against a picture that was never true.
 *
 * So there is one construction, and every caller uses it. Recipe context (household, ancestors) is
 * the only thing a caller adds, because only a recipe has any.
 */
export interface ResolverQueryOptions {
  /** Which household's recipes the mealie-recipe provider may read. */
  householdId?: string | null
  /** Recipes already being resolved, so a recipe cannot resolve through itself or a cycle. */
  ancestorSlugs?: string[]
  /**
   * Resolve as if no user-confirmed override existed for this ingredient.
   *
   * The honest way to answer "what would happen without my override?" — asking the real chain
   * with one provider silenced, rather than reasoning about what it might have said.
   */
  ignoreOverrides?: boolean
}

export interface ResolverQueryResult {
  query: ProviderQuery
  route: FoodRoute
}

export function buildResolverQuery(
  structuredName: string,
  classification: IngredientClassification | undefined,
  options: ResolverQueryOptions = {},
): ResolverQueryResult {
  const canonicalEnglish = classification?.canonicalEnglish ?? structuredName
  const canonicalGerman = classification?.canonicalGerman ?? structuredName
  const brand = classification?.brand ?? null
  const route: FoodRoute = classification?.route ?? "generic"
  const state: FoodState = classification?.state ?? "unknown"
  const foodType = classification?.foodType ?? "unknown"
  const coreFoodGerman = classification?.coreFoodGerman ?? null
  const coreFoodEnglish = classification?.coreFoodEnglish ?? null

  return {
    route,
    query: {
      foodName: canonicalEnglish,
      structuredName,
      canonicalGerman,
      brand,
      category: classification?.category ?? null,
      state,
      foodType,
      coreFoodGerman,
      coreFoodEnglish,
      route,
      attributes: classification?.attributes ?? UNKNOWN_ATTRIBUTES,
      householdId: options.householdId ?? null,
      ancestorSlugs: options.ancestorSlugs ?? [],
      ...(options.ignoreOverrides ? { ignoreOverrides: true } : {}),
      // What is actually KNOWN about this ingredient's identity. Absent evidence must make a
      // provider stricter, never more permissive — see identity-evidence.ts.
      evidence: evidenceFor(
        { llmClassified: classification?.llmClassified ?? false, canonicalGerman, coreFoodGerman, coreFoodEnglish, brand },
        structuredName,
      ),
    },
  }
}
