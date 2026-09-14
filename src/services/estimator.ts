import crypto from "node:crypto"
import type {
  MealieRecipe, IngredientMatch, EstimateResult, NutritionPatch,
  NutrientSet, MealieNutrition, Completeness, FoodState,
} from "../types.js"
import { config } from "../config.js"
import { convertToGrams } from "./unit-converter.js"
import { resolveNutrients } from "./nutrient-resolver.js"
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

  for (const ing of validIngredients) {
    const classification = classificationByIndex.get(ing.index)
    const canonicalName = classification?.canonicalName ?? ing.foodName
    const brand = classification?.brand ?? null
    const route = classification?.route ?? "generic"
    const state: FoodState = classification?.state ?? "unknown"

    let grams: number | null = null
    let gramsEstimated = false

    const converted = convertToGrams(ing.quantity, ing.unit, canonicalName)
    if (converted) {
      grams = converted.grams
      gramsEstimated = converted.estimated
    } else if (ing.unit?.name) {
      const llmGrams = await estimateGrams(ing.quantity, ing.unit.name, canonicalName)
      if (llmGrams !== null) {
        grams = llmGrams
        gramsEstimated = true
      }
    }

    if (grams === null) {
      unmatchedNames.push(ing.foodName)
      matchedIngredients.push({
        name: ing.foodName, canonicalName, brand, route, grams: null, gramsEstimated: false,
        matched: false, nutrients: null, provider: null, providerId: null, confidence: null,
        fallbackStatus: "unresolved", llmParticipated: classification?.llmClassified ?? false,
      })
      continue
    }

    totalKnownWeight += grams

    const resolved = await resolveNutrients({ foodName: canonicalName, brand, category: classification?.category ?? null, state }, route)

    if (!resolved) {
      unmatchedNames.push(ing.foodName)
      matchedIngredients.push({
        name: ing.foodName, canonicalName, brand, route, grams, gramsEstimated,
        matched: false, nutrients: null, provider: null, providerId: null, confidence: null,
        fallbackStatus: "unresolved", llmParticipated: classification?.llmClassified ?? false,
      })
      continue
    }

    totalNutrients = addToTotal(totalNutrients, resolved.match.nutrients, grams)
    resolvedWeight += grams
    hasAnyMatch = true

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
      confidence: resolved.match.confidence,
      fallbackStatus: resolved.fallbackStatus,
      llmParticipated: (classification?.llmClassified ?? false) || resolved.fallbackStatus === "llm-nutrient",
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
  }

  logger.info(
    {
      slug: recipe.slug,
      servings,
      completeness,
      totalKcal: effectiveTotal.kcalPer100g,
      kcalPerServing: perServingNutrients.kcalPer100g,
      matched: result.matchedCount,
      unmatched: result.unmatchedCount,
    },
    "Estimated nutrition for recipe",
  )

  return result
}

/** Detects nutrition that was entered by hand and never touched by the estimator at all. */
export function hasManualCalories(recipe: MealieRecipe): boolean {
  const hasHash = recipe.extras?.calorie_estimator_hash != null
  const hasStoredNutrition =
    recipe.nutrition?.calories != null && recipe.nutrition.calories.trim().length > 0

  return !hasHash && hasStoredNutrition
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

  const llmIngredients = result.matchedIngredients.filter((i) => i.llmParticipated).map((i) => i.name)
  if (llmIngredients.length > 0) {
    extras.calorie_estimator_llm_ingredients = JSON.stringify(llmIngredients)
  }

  const provenance = result.matchedIngredients.map((i) => ({
    name: i.name,
    canonical: i.canonicalName,
    brand: i.brand,
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
