import { evidenceFor } from "./identity-evidence.js"
import { UNKNOWN_ATTRIBUTES, type FoodAttributes, type FoodRoute, type FoodState, type IngredientClassification } from "../types.js"
import type { ProviderQuery } from "./providers/types.js"
import { lookupVocabulary } from "./vocabulary/recipe-vocabulary.js"
import type { VocabularyMatch } from "./vocabulary/types.js"

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
  /** The matched row, including observation-only matches. See query.vocabulary for application. */
  vocabulary: VocabularyMatch | null
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
  const classifierAttributes = classification?.attributes ?? UNKNOWN_ATTRIBUTES

  // ENRICHMENT, not substitution. The curated vocabulary supplies the one thing deterministic mode
  // cannot derive — a canonical identity — and supplies it only where nothing better is known.
  //
  // Looked up on the ingredient's own words, because that is what a cook wrote and what the
  // vocabulary was measured against. A classifier that already produced a core keeps it: the
  // vocabulary exists to cover the case where there is no classifier, and must not overrule one.
  const vocabulary = lookupVocabulary(structuredName)
  const classifierSupported = classification?.llmClassified === true || coreFoodGerman !== null || coreFoodEnglish !== null
  const enrichment = classifierSupported ? null : vocabulary
  const identity = enrichment?.identity ?? null
  const vocabularyCore = coreFoodGerman === null && identity !== null ? identity : null

  // Only attributes the ALIAS itself states, and only where the ingredient stated nothing. An
  // explicit "fettarme Milch" must never be overwritten by a default attached to "Milch".
  const claimedForm = enrichment?.attributes?.form
  const claimedPreservation = enrichment?.attributes?.preservation
  const attributes: FoodAttributes = {
    ...classifierAttributes,
    ...(classifierAttributes.fatPercent === null && enrichment?.attributes.fatPercent !== undefined
      ? { fatPercent: enrichment.attributes.fatPercent } : {}),
    ...(classifierAttributes.form === "unknown" && claimedForm !== undefined ? { form: claimedForm } : {}),
    ...(classifierAttributes.preservation === "unknown" && claimedPreservation !== undefined
      ? { preservation: claimedPreservation } : {}),
  }
  // A state the alias states ("Cooked Puy Lentils") applies only when the ingredient states none.
  const vocabularyState = enrichment?.attributes?.state
  const effectiveState: FoodState =
    state === "unknown" && (vocabularyState === "cooked" || vocabularyState === "dried" || vocabularyState === "raw")
      ? vocabularyState
      : state

  return {
    route,
    vocabulary,
    query: {
      foodName: canonicalEnglish,
      structuredName,
      canonicalGerman,
      brand,
      category: classification?.category ?? null,
      state: effectiveState,
      foodType,
      coreFoodGerman: coreFoodGerman ?? vocabularyCore,
      coreFoodEnglish,
      route,
      attributes,
      ...(vocabulary
        ? { vocabulary: {
              ...(enrichment?.preferred ? { preferred: enrichment.preferred } : {}),
              ...(enrichment?.kind === "ambiguous" ? { ambiguous: true } : {}),
              semanticsApplied: vocabularyCore !== null || effectiveState !== state
                || attributes.form !== classifierAttributes.form
                || attributes.preservation !== classifierAttributes.preservation
                || attributes.fatPercent !== classifierAttributes.fatPercent
                || enrichment?.kind === "ambiguous",
              kind: vocabulary.kind, alias: vocabulary.alias,
            } }
        : {}),
      householdId: options.householdId ?? null,
      ancestorSlugs: options.ancestorSlugs ?? [],
      ...(options.ignoreOverrides ? { ignoreOverrides: true } : {}),
      // What is actually KNOWN about this ingredient's identity. Absent evidence must make a
      // provider stricter, never more permissive — see identity-evidence.ts.
      evidence: evidenceFor(
        { llmClassified: classification?.llmClassified ?? false, canonicalGerman, coreFoodGerman: coreFoodGerman ?? vocabularyCore, coreFoodEnglish, brand },
        structuredName,
      ),
    },
  }
}
