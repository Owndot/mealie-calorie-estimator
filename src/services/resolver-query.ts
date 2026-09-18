import { evidenceFor } from "./identity-evidence.js"
import { UNKNOWN_ATTRIBUTES, type FoodAttributes, type FoodRoute, type FoodState, type IngredientClassification } from "../types.js"
import type { ProviderQuery } from "./providers/types.js"
import { lookupVocabulary } from "./vocabulary/recipe-vocabulary.js"
import { coreIdentityConflict } from "./providers/ranking.js"
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

  // A vocabulary row carries two different KINDS of thing, and they get different precedence.
  //
  // ENRICHMENT — identity text, attributes, state — fills a gap. A classifier that already
  // produced a core keeps it: the vocabulary exists to cover the case where there is no
  // classifier, and must not overrule one. AI wins.
  //
  // ASSERTIONS — `preferred` and `ambiguous` — are reviewed human judgements about this exact
  // alias, not guesses to be filled in. They stay active whatever the classifier produced.
  //
  // Both were gated on `classifierSupported` until this was measured: enabling AI silently
  // discarded every curated pointer and every ambiguity guard, and made AI-assisted mode WORSE
  // than deterministic mode on curated ingredients. "Basmatireis" carries a reviewed pointer to
  // BLS C352000 (351 kcal) and resolved to it deterministically; with AI on, the pointer was
  // dropped, nothing else matched, and the ingredient fell through to a fabricated estimate.
  // "Bohnen" is an `ambiguous` row spanning 28-344 kcal/100 g: deterministic mode correctly
  // withheld it, AI mode confidently answered "Beans, cannellini, dry" at 345. "rote Paprika"
  // has a reviewed pointer to the RED record and AI mode returned the green one.
  //
  // A classifier's free-text core is not evidence about a curated pointer. Real contradicting
  // evidence — a stated state, form, preservation or fat class — still overrides an assertion,
  // and that is checked where the assertion is applied (see preferredVocabularyMatch()).
  //
  // Looked up on the ingredient's own words, because that is what a cook wrote and what the
  // vocabulary was measured against.
  const vocabulary = lookupVocabulary(structuredName)
  const classifierSupported = classification?.llmClassified === true || coreFoodGerman !== null || coreFoodEnglish !== null
  const enrichment = classifierSupported ? null : vocabulary

  // A classifier CONTRADICTS the row when it renames the FOOD: it read "Mehl" and called the food
  // "Gerstenmehl", which is barley, not the wheat the curated row means. That is the classifier
  // contributing identity evidence, and it outranks a default written for the bare word — so the
  // pointer yields and ordinary resolution decides.
  //
  // The question is asked with coreIdentityConflict, the same gate retrieval uses, in the same
  // direction it is used everywhere else: "is this name accounted for by that identity?" Here the
  // curated text plays the part of the identity, so German compounding, plural tolerance and
  // stemming all come for free — "Basmati-Reis", "Basmati Reis" and "Reis" are all accounted for
  // by "Basmatireis", while "Gerstenmehl" is not accounted for by "Mehl".
  //
  // BOTH curated fields count, because either is a reviewed statement of the same food and a
  // classifier may legitimately echo either. Checking only the alias measured 19 of 51 German rows
  // suppressed when the model returned the row's own identity ("Limete" -> "Limette", "Muskat" ->
  // "Muskatnuss", "rote Paprika" -> "Gemüsepaprika") and 8 of 10 English rows suppressed as soon
  // as the model produced a German canonical at all, which is the normal case for them.
  //
  // An earlier attempt compared normalized strings for equality. That was far too broad: measured
  // on the recorded corpus the model rewrites canonicalGerman for 10% of ingredients — plurals,
  // hyphens, word order, expanded abbreviations — and treating those as contradictions sent
  // "Basmatireis" to parboiled rice, "rote Paprika" to the green record and "Rohrzucker" to
  // sweetcorn. Validated over all 70 rows carrying a pointer: 194 same-food rewrites, none
  // suppressed; every contradiction control still caught.
  //
  // Only asked when a classifier actually spoke. Deterministic mode has canonicalGerman ===
  // structuredName by construction, so the pointer applies exactly as before.
  const classifierRenamedIngredient = classification?.llmClassified === true
    && vocabulary !== null
    && coreIdentityConflict(canonicalGerman, vocabulary.alias, "compound")
    && (vocabulary.identity === null || coreIdentityConflict(canonicalGerman, vocabulary.identity, "compound"))

  /**
   * The curated assertions. Unlike enrichment these are reviewed judgements about this exact
   * alias, so classifier output does not suppress them — only classifier evidence that
   * contradicts them does, and for `preferred` that means renaming the food.
   *
   * `ambiguous` is NOT subject to even that: a refusal to guess is never made safer by a
   * classifier's confidence. Lifting an ambiguity needs explicit disambiguating evidence
   * (a stated form/part/state), and no such path exists yet — see the note in
   * narrowsAmbiguousIngredient(). Until one does, the refusal stands.
   */
  const assertion = vocabulary
  const preferredAssertion = classifierRenamedIngredient ? undefined : vocabulary?.preferred
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
              // Assertions: independent of whether a classifier ran.
              ...(preferredAssertion ? { preferred: preferredAssertion } : {}),
              ...(assertion?.kind === "ambiguous" ? { ambiguous: true } : {}),
              semanticsApplied: vocabularyCore !== null || effectiveState !== state
                || attributes.form !== classifierAttributes.form
                || attributes.preservation !== classifierAttributes.preservation
                || attributes.fatPercent !== classifierAttributes.fatPercent
                || assertion?.kind === "ambiguous",
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
