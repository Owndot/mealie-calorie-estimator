import crypto from "node:crypto"
import type {
  MealieRecipe, IngredientMatch, EstimateResult, NutritionPatch,
  NutrientSet, MealieNutrition, Completeness, MatchQuality, FoodState,
  EvidenceClass, RecipeEvidence,
} from "../types.js"
import { config } from "../config.js"
import { convertToGrams } from "./unit-converter.js"
import { UNKNOWN_ATTRIBUTES } from "../types.js"
import { resolveNutrients } from "./nutrient-resolver.js"
import { lookupVocabulary } from "./vocabulary/recipe-vocabulary.js"
import { judgeNeed } from "./providers/judge/judge-need.js"
import { buildResolverQuery } from "./resolver-query.js"
import { normalizeIngredients, type NormalizerInput } from "./llm-normalizer.js"
import { estimateGrams } from "./llm-estimator.js"
import { computeNutritionFingerprint } from "./nutrition-format.js"
import { logger } from "../utils/logger.js"

/**
 * Hashed from structured fields only (quantity/unit.name/food.name, plus yield/servings text) —
 * recipeIngredient[].originalText is never read here or anywhere else in the pipeline.
 */
export function computeIngredientHash(recipe: MealieRecipe): string {
  const parts: string[] = []

  for (const ing of recipe.recipeIngredient) {
    const qty = ing.quantity ?? 0
    const unitName = ing.unit?.name ?? ""
    const foodName = ing.food?.name ?? ""
    parts.push(`${qty}|${unitName}|${foodName}`)
  }

  parts.sort()
  parts.push(`yield:${recipe.recipeYield ?? ""}`)
  parts.push(`servings:${recipe.recipeServings ?? ""}`)
  const hash = crypto.createHash("sha256").update(parts.join(",")).digest("hex")
  return hash
}

export function shouldEstimate(recipe: MealieRecipe): boolean {
  if (config.estimate.strategy === "all") return true
  const tagName = config.estimate.tag.toLowerCase()
  return (recipe.tags || []).some(t => t.slug === tagName || t.name.toLowerCase() === tagName)
}

/** Informational only — recipeYield text is never used to divide nutrition. See recipe.recipeServings for that. */
export function parseYield(recipeYield: string | null): number | null {
  if (!recipeYield) return null

  const rangeMatch = recipeYield.match(/(\d+)\s*[-–]\s*(\d+)/)
  if (rangeMatch) {
    return Math.round((parseInt(rangeMatch[1], 10) + parseInt(rangeMatch[2], 10)) / 2)
  }

  const numMatch = recipeYield.match(/(\d+(?:[.,]\d+)?)/)
  if (numMatch) {
    return parseFloat(numMatch[1].replace(",", "."))
  }

  return null
}

function emptyNutrients(): NutrientSet {
  return {
    kcalPer100g: null,
    proteinPer100g: null,
    carbsPer100g: null,
    fatPer100g: null,
    saturatedFatPer100g: null,
    transFatPer100g: null,
    unsaturatedFatPer100g: null,
    fiberPer100g: null,
    sugarPer100g: null,
    sodiumPer100g: null,
    cholesterolPer100g: null,
  }
}

function addToTotal(total: NutrientSet, nutrients: NutrientSet, grams: number): NutrientSet {
  const factor = grams / 100
  const add = (a: number | null, b: number | null): number | null => {
    if (a === null && b === null) return null
    return (a ?? 0) + (b ?? 0) * factor
  }

  return {
    kcalPer100g: add(total.kcalPer100g, nutrients.kcalPer100g),
    proteinPer100g: add(total.proteinPer100g, nutrients.proteinPer100g),
    carbsPer100g: add(total.carbsPer100g, nutrients.carbsPer100g),
    fatPer100g: add(total.fatPer100g, nutrients.fatPer100g),
    saturatedFatPer100g: add(total.saturatedFatPer100g, nutrients.saturatedFatPer100g),
    transFatPer100g: add(total.transFatPer100g, nutrients.transFatPer100g),
    unsaturatedFatPer100g: add(total.unsaturatedFatPer100g, nutrients.unsaturatedFatPer100g),
    fiberPer100g: add(total.fiberPer100g, nutrients.fiberPer100g),
    sugarPer100g: add(total.sugarPer100g, nutrients.sugarPer100g),
    sodiumPer100g: add(total.sodiumPer100g, nutrients.sodiumPer100g),
    cholesterolPer100g: add(total.cholesterolPer100g, nutrients.cholesterolPer100g),
  }
}

/**
 * Divides whole-recipe totals by servings exactly once. servings must be recipe.recipeServings —
 * never recipeYield (a free-text field like "1 loaf" that is not reliably a serving count) and
 * never used anywhere in provider lookup or ingredient-level math.
 */
function divideByServings(total: NutrientSet, servings: number): NutrientSet {
  const div = (v: number | null): number | null => (v !== null ? Math.round(v / servings) : null)
  // Sodium/cholesterol are kept as precise fractional grams here (not rounded to whole grams) —
  // they're small enough that rounding to an integer gram would collapse them to 0 before the
  // gram->milligram conversion at the Mealie-patch boundary gets a chance to round sensibly.
  const divPrecise = (v: number | null): number | null => (v !== null ? v / servings : null)
  return {
    kcalPer100g: div(total.kcalPer100g),
    proteinPer100g: div(total.proteinPer100g),
    carbsPer100g: div(total.carbsPer100g),
    fatPer100g: div(total.fatPer100g),
    saturatedFatPer100g: div(total.saturatedFatPer100g),
    transFatPer100g: div(total.transFatPer100g),
    unsaturatedFatPer100g: div(total.unsaturatedFatPer100g),
    fiberPer100g: div(total.fiberPer100g),
    sugarPer100g: div(total.sugarPer100g),
    sodiumPer100g: divPrecise(total.sodiumPer100g),
    cholesterolPer100g: divPrecise(total.cholesterolPer100g),
  }
}

interface ValidIngredient {
  index: number
  foodName: string
  quantity: number
  unit: import("../types.js").MealieUnit | null
}

function collectValidIngredients(recipe: MealieRecipe): ValidIngredient[] {
  const result: ValidIngredient[] = []
  recipe.recipeIngredient.forEach((ing, index) => {
    const foodName = ing.food?.name
    const quantity = ing.quantity
    if (!foodName || quantity == null || quantity <= 0) return
    result.push({ index, foodName, quantity, unit: ing.unit })
  })
  return result
}

/**
 * Recipe-evidence classification threshold: above this share of total CALORIES coming from
 * `llm-nutrient`, a recipe is summarised as `estimated` rather than `mixed`.
 *
 * A CLASSIFICATION/PRESENTATION threshold — neither a trust boundary nor a withholding one.
 * It does not mark where generated numbers start being unreliable (they are generated at any
 * share), and crossing it withholds nothing: an `estimated` recipe is written exactly like any
 * other, just labelled honestly. Withholding remains purely a COVERAGE decision, made by
 * classifyCompleteness from unresolved weight and untouched by this axis.
 *
 * Below it, `mixed` still means "contains estimated content" and must not be read as
 * database-backed; the exact share is always persisted, so this can be retuned later without
 * touching provenance or migrating anything.
 *
 * Deliberately one named constant: the literal must not be scattered through code or tests.
 */
export const EVIDENCE_ESTIMATED_KCAL_SHARE = 0.25

/**
 * Maps a provider to its evidence class. THE extension point for new evidence kinds.
 *
 * Only a value this service GENERATED is `estimated`. Everything else is a real record, including
 * one reached with model assistance: LLM normalization, reranking and the semantic judge all end
 * on a record some database actually publishes, and that record is what the numbers come from.
 *
 * Overrides need no case of their own — override-provider.ts reports the REAL underlying provider
 * and records the override only as matchReason, so an override classifies through its target. A
 * future custom-food provider would be added here as its own class.
 */
export function evidenceClassFor(provider: string): EvidenceClass {
  return provider === "llm-nutrient" ? "estimated" : "database"
}

/**
 * Summarises the evidence mix. Keyed on the estimated CONTRIBUTION rather than the share so that a
 * zero-calorie recipe (water and salt) is still correctly `database`: its share is null because
 * there are no calories to divide, but "none of them were estimated" remains true.
 */
function classifyEvidence(
  estimatedKcal: number,
  totalKcal: number,
  hasAnyMatch: boolean,
): RecipeEvidence | null {
  if (!hasAnyMatch) return null
  if (estimatedKcal === 0) return "database"
  if (totalKcal <= 0) return "estimated"
  return estimatedKcal / totalKcal > EVIDENCE_ESTIMATED_KCAL_SHARE ? "estimated" : "mixed"
}

/** Significance threshold: unresolved weight above this fraction of total known weight withholds nutrition entirely. */
const WITHHOLD_WEIGHT_FRACTION = 0.3

function classifyCompleteness(
  unmatchedCount: number,
  resolvedWeight: number,
  totalKnownWeight: number,
  hasAnyMatch: boolean,
): { completeness: Completeness; reason: string | null } {
  if (unmatchedCount === 0) {
    return { completeness: "complete", reason: null }
  }

  if (!hasAnyMatch) {
    return { completeness: "withheld", reason: "No ingredient could be resolved to nutrition data" }
  }

  const unresolvedFraction = totalKnownWeight > 0 ? (totalKnownWeight - resolvedWeight) / totalKnownWeight : 1

  if (unresolvedFraction > WITHHOLD_WEIGHT_FRACTION) {
    return {
      completeness: "withheld",
      reason: `${Math.round(unresolvedFraction * 100)}% of known ingredient weight is unresolved — nutrition withheld to avoid a misleading result`,
    }
  }

  return { completeness: "partial", reason: `${unmatchedCount} ingredient(s) unresolved but weight share is minor` }
}

/**
 * Per-ingredient confidence below which a match is reported as needing a caveat. Calibrated
 * against what the providers actually emit: an exact BLS name match is 0.92, a strong fuzzy BLS or
 * USDA match lands in the 0.7-0.85 band, a BLS record broadened to a sub-variety is that times
 * 0.8, and an LLM nutrient estimate is a flat 0.35.
 */
const LOW_CONFIDENCE_THRESHOLD = 0.6
const HIGH_QUALITY_MEAN = 0.75
const LOW_QUALITY_MEAN = 0.55
/** A single ingredient contributing more than this share of total energy cannot be outvoted. */
const DOMINANT_CONTRIBUTION_SHARE = 0.2

/**
 * Grades the RECORDS that were found, independently of how much of the recipe they cover.
 *
 * Weighted by each ingredient's share of total energy, so the grade tracks how much of the number
 * actually rests on a doubtful match. A dominant ingredient is checked separately as well: a 400 g
 * bean match at 0.55 confidence is 40% of a curry's calories, and averaging it against a dozen
 * confident herbs would hide exactly the case worth surfacing.
 */
export function classifyMatchQuality(
  matched: IngredientMatch[],
): { matchQuality: MatchQuality; reason: string | null; lowConfidence: string[] } {
  const contributions = matched
    .filter((i) => i.matched && i.nutrients?.kcalPer100g != null && i.grams != null)
    .map((i) => ({ i, kcal: Math.abs((i.nutrients!.kcalPer100g! * i.grams!) / 100) }))

  // "Risky" is broader than "low confidence in the record". An ingredient can be matched perfectly
  // and still be the riskiest number in the recipe — because its WEIGHT was guessed, or because the
  // record answers a different product than the one written down. Match quality is meant to point
  // at nutrition totals a user should not trust, so it weighs all three.
  const risky = (i: IngredientMatch): string | null => {
    if (!i.matched) return null
    // Most specific cause first. An unmet claim CAPS confidence, so checking confidence first would
    // always answer "low-confidence" and bury the one explanation a user can act on.
    if ((i.unmetAttributes?.length ?? 0) > 0) return `the selected record does not satisfy the explicit ${i.unmetAttributes!.join("/")} attribute`
    if ((i.confidence ?? 0) < LOW_CONFIDENCE_THRESHOLD) return "the match is low-confidence"
    if (i.gramsEstimated && i.fallbackStatus !== "unresolved") return "its weight was estimated"
    return null
  }
  const lowConfidence = matched.filter((i) => risky(i) !== null).map((i) => i.name)

  if (contributions.length === 0) {
    // Nothing energy-bearing resolved; coverage already reports that, and there is no quality
    // signal to give. Reported as "low" rather than silently "high".
    return { matchQuality: "low", reason: "no energy-bearing ingredient resolved", lowConfidence }
  }

  const totalKcal = contributions.reduce((a, c) => a + c.kcal, 0)
  // With no energy at all (a recipe of water and salt) every weight is 0, so fall back to an
  // unweighted mean rather than dividing by zero.
  const weighted = totalKcal > 0
    ? contributions.reduce((a, c) => a + (c.i.confidence ?? 0) * (c.kcal / totalKcal), 0)
    : contributions.reduce((a, c) => a + (c.i.confidence ?? 0), 0) / contributions.length

  const dominantDoubt = totalKcal > 0
    ? contributions.find((c) => c.kcal / totalKcal > DOMINANT_CONTRIBUTION_SHARE && risky(c.i) !== null)
    : undefined

  if (dominantDoubt) {
    const share = Math.round((dominantDoubt.kcal / totalKcal) * 100)
    return {
      matchQuality: weighted < LOW_QUALITY_MEAN ? "low" : "mixed",
      reason: `"${dominantDoubt.i.name}" contributes ${share}% of the calories, but ${risky(dominantDoubt.i)} (${dominantDoubt.i.productName ?? "no record"})`,
      lowConfidence,
    }
  }

  if (weighted >= HIGH_QUALITY_MEAN) return { matchQuality: "high", reason: null, lowConfidence }
  if (weighted < LOW_QUALITY_MEAN) {
    return { matchQuality: "low", reason: `calorie-weighted match confidence is ${weighted.toFixed(2)}`, lowConfidence }
  }
  return { matchQuality: "mixed", reason: `calorie-weighted match confidence is ${weighted.toFixed(2)}`, lowConfidence }
}

/** Compact provenance: which curated row was consulted, and how strong a claim it makes. */
function vocabularyProvenance(foodName: string): { alias: string; kind: string } | null {
  const match = lookupVocabulary(foodName)
  return match ? { alias: match.alias, kind: match.kind } : null
}

export async function estimateRecipe(recipe: MealieRecipe): Promise<EstimateResult> {
  const validIngredients = collectValidIngredients(recipe)

  const normalizerInputs: NormalizerInput[] = validIngredients.map((v) => ({
    index: v.index,
    foodName: v.foodName,
    unitName: v.unit?.name ?? null,
  }))
  const classifications = await normalizeIngredients(normalizerInputs)
  const classificationByIndex = new Map(classifications.map((c) => [c.index, c]))

  const matchedIngredients: IngredientMatch[] = []
  const unmatchedNames: string[] = []
  let totalNutrients = emptyNutrients()
  let resolvedWeight = 0
  let totalKnownWeight = 0
  let hasAnyMatch = false
  // Calorie contributions split by evidence class. Weight would be the wrong measure here: a litre
  // of estimated stock barely matters, 30 g of estimated oil does.
  let totalKcalContribution = 0
  let estimatedKcalContribution = 0

  for (const ing of validIngredients) {
    const classification = classificationByIndex.get(ing.index)
    const canonicalEnglish = classification?.canonicalEnglish ?? ing.foodName
    const canonicalGerman = classification?.canonicalGerman ?? ing.foodName
    const brand = classification?.brand ?? null
    const route = classification?.route ?? "generic"
    const state: FoodState = classification?.state ?? "unknown"
    const foodType = classification?.foodType ?? "unknown"
    const coreFoodGerman = classification?.coreFoodGerman ?? null
    const coreFoodEnglish = classification?.coreFoodEnglish ?? null

    let grams: number | null = null
    let gramsEstimated = false

    // The density/piece tables get the SAME identity bundle the providers use, so a German
    // compound like "Gemuesebruehe" is recognised as a broth even when the English canonical is
    // unavailable — previously only canonicalEnglish was passed, so a degraded classification sent
    // the raw German name into a table that could not match it, and the ingredient fell through to
    // an unvalidated LLM gram estimate.
    const foodIdentity = { coreFoodGerman, coreFoodEnglish, canonicalGerman, canonicalEnglish, structuredName: ing.foodName }
    const converted = convertToGrams(ing.quantity, ing.unit, foodIdentity)
    if (converted) {
      grams = converted.grams
      gramsEstimated = converted.estimated
    } else if (ing.unit?.name) {
      const llmGrams = await estimateGrams(ing.quantity, ing.unit.name, canonicalEnglish)
      if (llmGrams !== null) {
        grams = llmGrams
        gramsEstimated = true
      }
    }

    // The classifier's own verdict, carried into provenance so a change in how an ingredient is
    // READ is visible without having to infer it from which record won. Built before the weight
    // check, so an ingredient whose grams cannot be resolved still reports how it was classified.
    const classificationRecord = {
      state,
      form: (classification?.attributes ?? UNKNOWN_ATTRIBUTES).form,
      preservation: (classification?.attributes ?? UNKNOWN_ATTRIBUTES).preservation,
      foodType,
      category: classification?.category ?? null,
      coreEnglish: coreFoodEnglish,
      cached: classification?.fromCache ?? false,
      vocabulary: vocabularyProvenance(ing.foodName),
    }

    if (grams === null) {
      unmatchedNames.push(ing.foodName)
      matchedIngredients.push({
        name: ing.foodName, canonicalName: canonicalEnglish, brand, route, grams: null, gramsEstimated: false,
        matched: false, nutrients: null, provider: null, providerId: null, productName: null, confidence: null,
        fallbackStatus: "unresolved", llmParticipated: classification?.llmClassified ?? false,
        classification: classificationRecord,
      })
      continue
    }

    totalKnownWeight += grams

    // One construction, shared with the override-preview endpoint — see buildResolverQuery().
    // This recipe is an ancestor of anything it resolves, which is what stops a recipe resolving
    // through itself or through a cycle.
    const built = buildResolverQuery(ing.foodName, classification, {
      householdId: recipe.householdId ?? recipe.household_id ?? null,
      ancestorSlugs: [recipe.slug],
    })
    const resolved = await resolveNutrients(built.query, built.route)

    // Judge ELIGIBILITY, computed for every resolution attempt whether or not the judge is
    // enabled. It is a pure, local function of the classification and the outcome — no request,
    // no pool construction — so recording it costs nothing and lets the trigger be validated
    // against real recipes before any behaviour depends on it. See judge/judge-need.ts.
    const need = judgeNeed({
      structuredName: ing.foodName,
      canonicalEnglish,
      coreFoodEnglish,
      attributes: classification?.attributes ?? UNKNOWN_ATTRIBUTES,
      foodType,
      match: resolved?.match ?? null,
      fallbackStatus: resolved?.fallbackStatus ?? "unresolved",
    })
    // When the judge actually ran, the trigger it ran UNDER is the truthful record — after a
    // successful selection the outcome is a database record, so judgeNeed() would now
    // (correctly) report nothing and the reason for asking would be lost.
    const judgeTrigger = resolved?.judge?.trigger ?? (need ? need.reasons.join(",") : null)


    if (!resolved) {
      unmatchedNames.push(ing.foodName)
      matchedIngredients.push({
        name: ing.foodName, canonicalName: canonicalEnglish, brand, route, grams, gramsEstimated,
        matched: false, nutrients: null, provider: null, providerId: null, productName: null, confidence: null,
        fallbackStatus: "unresolved", llmParticipated: classification?.llmClassified ?? false,
        judgeTrigger, classification: classificationRecord,
      })
      continue
    }

    totalNutrients = addToTotal(totalNutrients, resolved.match.nutrients, grams)
    resolvedWeight += grams
    hasAnyMatch = true

    // An ingredient whose kcal is unknown is excluded from BOTH sides: it can neither inflate nor
    // dilute the share. Math.abs mirrors classifyMatchQuality's treatment of contributions.
    const kcalPer100g = resolved.match.nutrients.kcalPer100g
    if (kcalPer100g !== null && Number.isFinite(kcalPer100g)) {
      const contribution = Math.abs((kcalPer100g * grams) / 100)
      totalKcalContribution += contribution
      if (evidenceClassFor(resolved.match.provider) === "estimated") estimatedKcalContribution += contribution
    }

    matchedIngredients.push({
      name: ing.foodName,
      canonicalName: resolved.match.canonicalName,
      brand: resolved.match.brand,
      route,
      grams,
      gramsEstimated,
      matched: true,
      nutrients: resolved.match.nutrients,
      provider: resolved.match.provider,
      providerId: resolved.match.providerId,
      productName: resolved.match.productName,
      confidence: resolved.match.confidence,
      fallbackStatus: resolved.fallbackStatus,
      dataType: resolved.match.dataType ?? null,
      foodType: resolved.match.foodType,
      matchReason: resolved.match.matchReason,
      llmReranked: resolved.match.llmReranked ?? false,
      rerankReason: resolved.match.rerankReason ?? null,
      unmetAttributes: resolved.match.unmetAttributes ?? [],
      requestedFatPercent: classification?.attributes?.fatPercent ?? null,
      sourceRecipeSlug: resolved.match.sourceRecipeSlug ?? null,
      sourceRecipeFingerprint: resolved.match.sourceRecipeFingerprint ?? null,
      judgeTrigger,
      judgeVerdict: resolved.judge?.verdict === "invalid" ? null : (resolved.judge?.verdict ?? null),
      judgeReason: resolved.judge?.reason ?? null,
      judgeCandidates: resolved.judge?.candidates ?? null,
      judgePoolFingerprint: resolved.judge?.poolFingerprint ?? null,
      judgeModel: resolved.judge?.model ?? null,
      judgePromptVersion: resolved.judge?.promptVersion ?? null,
      classification: classificationRecord,
      // A reranked match DID involve the LLM, even though its nutrients came from a database.
      llmParticipated: (classification?.llmClassified ?? false)
        || resolved.fallbackStatus === "llm-nutrient"
        || (resolved.match.llmReranked ?? false),
    })
  }

  const { completeness, reason: completenessReason } = classifyCompleteness(
    unmatchedNames.length,
    resolvedWeight,
    totalKnownWeight,
    hasAnyMatch,
  )

  const servings = recipe.recipeServings
  const perServingNutrients =
    completeness !== "withheld" && servings && servings > 0 ? divideByServings(totalNutrients, servings) : emptyNutrients()
  const effectiveTotal = completeness === "withheld" ? emptyNutrients() : totalNutrients

  const { matchQuality, reason: matchQualityReason, lowConfidence } = classifyMatchQuality(matchedIngredients)

  // Shares are null when there are no calories to divide — distinct from 0, which asserts that
  // calories ARE known and none of them were estimated.
  const estimatedKcalShare = totalKcalContribution > 0
    ? Math.min(1, Math.max(0, estimatedKcalContribution / totalKcalContribution))
    : null
  const databaseKcalShare = estimatedKcalShare === null ? null : 1 - estimatedKcalShare
  const unresolvedWeightShare = totalKnownWeight > 0
    ? Math.min(1, Math.max(0, (totalKnownWeight - resolvedWeight) / totalKnownWeight))
    : 0
  const evidence = classifyEvidence(estimatedKcalContribution, totalKcalContribution, hasAnyMatch)

  const result: EstimateResult = {
    slug: recipe.slug,
    servings,
    totalNutrients: effectiveTotal,
    perServingNutrients,
    matchedCount: matchedIngredients.filter((i) => i.matched).length,
    unmatchedCount: unmatchedNames.length,
    unmatchedIngredients: unmatchedNames,
    matchedIngredients,
    completeness,
    completenessReason,
    evidence,
    estimatedKcalShare,
    databaseKcalShare,
    unresolvedWeightShare,
    matchQuality,
    matchQualityReason,
    lowConfidenceIngredients: lowConfidence,
  }

  logger.info(
    {
      slug: recipe.slug,
      servings,
      completeness,
      matchQuality,
      totalKcal: effectiveTotal.kcalPer100g,
      kcalPerServing: perServingNutrients.kcalPer100g,
      matched: result.matchedCount,
      unmatched: result.unmatchedCount,
    },
    "Estimated nutrition for recipe",
  )

  return result
}

/**
 * Detects nutrition that was entered by hand and never actually computed by a real estimate.
 *
 * A `calorie_estimator_hash` being present is NOT sufficient proof of a real prior estimate:
 * found against real production data (a live legacy-recipe regression check) — an older version
 * of this service's manual-ack path wrote `calorie_estimator_hash` (to avoid re-detecting the
 * same manual entry every run) without any other marker distinguishing "hash from an ack" from
 * "hash from a real estimate". That version predates `calorie_estimator_provenance`, which every
 * real estimate has always written unconditionally (see buildNutritionPatch) and no ack path
 * ever has. Its absence is therefore a reliable, version-independent signal that whatever
 * nutrition is present was never actually computed — whether that's because no hash exists at
 * all (a brand new manual entry) or a hash exists from an old-style ack (a legacy manual entry).
 */
export function hasManualCalories(recipe: MealieRecipe): boolean {
  const hasStoredNutrition =
    recipe.nutrition?.calories != null && recipe.nutrition.calories.trim().length > 0
  const hasEstimatorProvenance = recipe.extras?.calorie_estimator_provenance != null

  return hasStoredNutrition && !hasEstimatorProvenance
}

/**
 * True once a recipe has ever been acknowledged as manual — not just on the very first
 * detection. buildManualAckPatch always writes calorie_estimator_hash, so without a persistent
 * marker, hasManualCalories alone would only ever fire once: the very next ingredient change
 * would see a hash present and, absent this flag, fall through to a real estimate and silently
 * overwrite the human's value. The flag is cleared only by an actual estimate (buildNutritionPatch),
 * i.e. only via the explicit overrideManual path.
 */
export function isManuallyOwned(recipe: MealieRecipe): boolean {
  return recipe.extras?.calorie_estimator_manual === "true" || hasManualCalories(recipe)
}

/**
 * Detects nutrition the estimator wrote and owns (not manually-flagged) whose current values no
 * longer match the fingerprint of what it last wrote — i.e. a person edited it by hand since,
 * without the recipe ever going through the manual-ack path. Returns false (not modified) when
 * there's no stored fingerprint to compare against, either because this recipe was never
 * estimated, or because it was estimated by a version of the service predating this fingerprint
 * — a deliberate, conservative default so an upgrade doesn't suddenly treat every existing
 * recipe as manually modified.
 */
export function hasManuallyModifiedNutrition(recipe: MealieRecipe): boolean {
  const storedFingerprint = recipe.extras?.calorie_estimator_nutrition_fingerprint
  const hasHash = recipe.extras?.calorie_estimator_hash != null
  if (!hasHash || !storedFingerprint) return false

  return computeNutritionFingerprint(recipe.nutrition ?? {}) !== storedFingerprint
}

export type ManualProtectionReason = "never-estimated" | "modified-after-estimate"

export function buildManualAckPatch(recipe: MealieRecipe, hash: string, reason: ManualProtectionReason): NutritionPatch {
  // No `nutrition` key at all — confirmed live against Mealie: PATCHing `nutrition: {}` does NOT
  // leave existing values alone, it WIPES every field to null, since Mealie replaces the whole
  // sub-object rather than merging it field-by-field. Omitting the key entirely is the only way
  // to truly preserve what's there, which is the whole point of an "ack without overwriting".
  return {
    extras: {
      calorie_estimator_hash: hash,
      calorie_estimator_unmatched: JSON.stringify([]),
      // Persists manual ownership across future runs — see isManuallyOwned.
      calorie_estimator_manual: "true",
      calorie_estimator_note:
        reason === "modified-after-estimate"
          ? "Manual — nutrition was edited after estimation, preserved"
          : "Manual — preserved existing calorie entry",
    },
  }
}

function n(v: number | null): string {
  return v != null ? v.toString() : ""
}

/** schema.org NutritionInformation (which Mealie follows) expects sodium/cholesterol in milligrams; every other field in grams. */
function toMilligrams(gramsValue: number | null): number | null {
  return gramsValue != null ? Math.round(gramsValue * 1000) : null
}

export function buildNutritionPatch(
  result: EstimateResult,
  hash: string,
  recipeYield: string | null,
): NutritionPatch {
  const nutrition: Partial<MealieNutrition> = {}

  // Withheld results write no nutrition numbers at all — an important unresolved calorie-dense
  // ingredient must not produce a misleadingly "complete"-looking nutrition entry.
  if (result.completeness !== "withheld") {
    const p = result.perServingNutrients
    const add = (key: keyof MealieNutrition, val: string) => {
      if (val !== "") nutrition[key] = val
    }

    add("calories", n(p.kcalPer100g))
    add("proteinContent", n(p.proteinPer100g))
    add("carbohydrateContent", n(p.carbsPer100g))
    add("fatContent", n(p.fatPer100g))
    add("saturatedFatContent", n(p.saturatedFatPer100g))
    add("transFatContent", n(p.transFatPer100g))
    add("unsaturatedFatContent", n(p.unsaturatedFatPer100g))
    add("fiberContent", n(p.fiberPer100g))
    add("sugarContent", n(p.sugarPer100g))
    add("sodiumContent", n(toMilligrams(p.sodiumPer100g)))
    add("cholesterolContent", n(toMilligrams(p.cholesterolPer100g)))
  }

  const extras: Record<string, string> = {
    calorie_estimator_hash: hash,
    calorie_estimator_unmatched: JSON.stringify(result.unmatchedIngredients),
    calorie_estimator_status: result.completeness,
    // An actual estimate always clears manual ownership — only the explicit overrideManual path
    // reaches this function for a recipe that was previously flagged manual.
    calorie_estimator_manual: "false",
    // Fingerprints the exact `nutrition` object above (Mealie's own string/mg representation),
    // so a later run can tell "still ours, safe to overwrite" apart from "a person edited this
    // by hand" with no float round-trip or rounding involved.
    calorie_estimator_nutrition_fingerprint: computeNutritionFingerprint(nutrition),
  }

  if (result.completenessReason) {
    extras.calorie_estimator_status_reason = result.completenessReason
  }

  // EVIDENCE — a separate axis from the coverage status above. Written as its own key so
  // calorie_estimator_status keeps exactly the meaning and value set it has always had.
  //
  // The raw shares are persisted independently of the label: the label is a presentation choice
  // that may be retuned, the shares are the evidence. A null share is OMITTED rather than written
  // as "0" — "no calories to divide" and "calories known, none estimated" are different facts.
  if (result.evidence) extras.calorie_estimator_evidence = result.evidence
  if (result.estimatedKcalShare != null) {
    extras.calorie_estimator_estimated_kcal_share = result.estimatedKcalShare.toFixed(4)
  }
  if (result.databaseKcalShare != null) {
    extras.calorie_estimator_database_kcal_share = result.databaseKcalShare.toFixed(4)
  }
  extras.calorie_estimator_unresolved_weight_share = (result.unresolvedWeightShare ?? 0).toFixed(4)

  // COVERAGE and QUALITY are reported as separate keys. calorie_estimator_status keeps its exact
  // existing values and meaning, so nothing downstream breaks; these are additive.
  extras.calorie_estimator_match_quality = result.matchQuality
  if (result.matchQualityReason) {
    extras.calorie_estimator_match_quality_reason = result.matchQualityReason
  }
  if (result.lowConfidenceIngredients.length > 0) {
    extras.calorie_estimator_low_confidence = JSON.stringify(result.lowConfidenceIngredients)
  }

  // Dependencies on the user's OWN recipes, with a fingerprint of the nutrition/yield state each
  // one had when this estimate was made. A dependent recipe otherwise keeps a stale value forever:
  // its own ingredient hash does not change when a SOURCE recipe is re-estimated, so nothing would
  // ever prompt it to look again. Deliberately recorded rather than cascaded — a source change
  // invalidates the dependent at its next run, which is safe and cannot storm.
  const sources = result.matchedIngredients
    .filter((i) => i.sourceRecipeSlug && i.sourceRecipeFingerprint)
    .map((i) => [i.sourceRecipeSlug!, i.sourceRecipeFingerprint!] as const)
  if (sources.length > 0) {
    extras.calorie_estimator_recipe_sources = JSON.stringify(Object.fromEntries(sources))
  }

  const llmIngredients = result.matchedIngredients.filter((i) => i.llmParticipated).map((i) => i.name)
  if (llmIngredients.length > 0) {
    extras.calorie_estimator_llm_ingredients = JSON.stringify(llmIngredients)
  }

  const provenance = result.matchedIngredients.map((i) => ({
    name: i.name,
    canonical: i.canonicalName,
    brand: i.brand,
    providerId: i.providerId,
    productName: i.productName,
    dataType: i.dataType ?? null,
    foodType: i.foodType ?? null,
    matchReason: i.matchReason ?? null,
    // Records that the SELECTION was model-assisted while the nutrients stayed with `provider`.
    llmReranked: i.llmReranked ?? false,
    rerankReason: i.rerankReason ?? null,
    unmetAttributes: i.unmetAttributes ?? [],
    requestedFatPercent: i.requestedFatPercent ?? null,
    sourceRecipeSlug: i.sourceRecipeSlug ?? null,
    classification: i.classification ?? null,
    // Judge observability. judgeTrigger is present whenever something about this ingredient is
    // semantically unresolved; the rest stay null until the judge is enabled and actually runs.
    judgeTrigger: i.judgeTrigger ?? null,
    judgeVerdict: i.judgeVerdict ?? null,
    judgeReason: i.judgeReason ?? null,
    judgeCandidates: i.judgeCandidates ?? null,
    judgePoolFingerprint: i.judgePoolFingerprint ?? null,
    judgeModel: i.judgeModel ?? null,
    judgePromptVersion: i.judgePromptVersion ?? null,
    grams: i.grams,
    gramsEstimated: i.gramsEstimated,
    matched: i.matched,
    provider: i.provider,
    confidence: i.confidence,
    fallback: i.fallbackStatus,
  }))
  extras.calorie_estimator_provenance = JSON.stringify(provenance)

  const totalKcal = result.totalNutrients.kcalPer100g
  if (totalKcal !== null && totalKcal > 0) {
    extras.calorie_estimator_total_kcal = totalKcal.toString()
  }

  const servings = parseYield(recipeYield)
  if (servings !== null) {
    extras.calorie_estimator_yield = servings.toString()
  }

  return { nutrition, extras }
}
