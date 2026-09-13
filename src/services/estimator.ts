import { interpretIngredient, NUTRITION_VERSION } from "./ingredient-context.js"
import { genericNutrients } from "./generic-foods.js"
import { emptyAmounts, addAmounts, amountsFromProfile, divideAmounts, legacyAmounts } from "./nutrient-amounts.js"
import { recipeWarnings, sanitizeNutritionPatch, validateProfile } from "./nutrition-validation.js"
import crypto from "node:crypto"
import type {
  MealieRecipe, IngredientMatch, EstimateResult, NutritionPatch,
  NutrientSet, MealieNutrition,
} from "../types.js"
import { config } from "../config.js"
import { convertToGrams, resolveUnitName } from "./unit-converter.js"
import { lookupNutrients } from "./off-client.js"
import { estimateGrams, estimateNutrients } from "./llm-estimator.js"
import { logger } from "../utils/logger.js"

export function computeIngredientHash(recipe: MealieRecipe): string {
  // Hash only inputs read by the estimator, never API metadata or our own output.
  // Project into fixed-order arrays so JSON object key order cannot cause retries.
  const instructions = recipe.recipeInstructions ?? []
  const ingredients = recipe.recipeIngredient.map(ing => JSON.stringify([
    ing.quantity ?? null, ing.food?.name ?? "",
    ing.unit?.name ?? "", ing.unit?.abbreviation ?? "",
    ing.unit?.standardQuantity ?? null, ing.unit?.standardUnit ?? "",
    ing.note ?? "", ing.originalText ?? "", ing.original_text ?? "", ing.display ?? "", ing.title ?? "",
    instructions.filter(step => typeof step !== "string" && ing.referenceId
      && step.ingredientReferences?.some(ref => ref.referenceId === ing.referenceId))
      .map(step => typeof step === "string" ? step : step.text).sort(),
  ])).sort()
  const input = [
    NUTRITION_VERSION, "input-hash-v2-partial-webhook",
    config.estimate.partialPolicy, config.units.pinchGrams,
    config.openFoodFacts.language, config.openFoodFacts.baseUrl, config.openFoodFacts.searchBaseUrl,
    config.llm.enabled, config.llm.model, config.llm.baseUrl, config.llm.endpointUrl,
    ingredients, instructions.map(step => typeof step === "string" ? step : step.text),
    recipe.recipeYield ?? "", recipe.recipeServings ?? null,
  ]
  return crypto.createHash("sha256").update(JSON.stringify(input)).digest("hex")
}

export function shouldEstimate(recipe: MealieRecipe): boolean {
  if (config.estimate.strategy === "all") return true
  const tagName = config.estimate.tag.toLowerCase()
  return (recipe.tags || []).some(t => t.slug === tagName || t.name.toLowerCase() === tagName)
}

export function parseYield(recipeYield: string | null): number | null {
  if (!recipeYield) return null
  const text = recipeYield.trim()
  if (/^-/.test(text)) return null
  const range = text.match(/(\d+(?:[.,]\d+)?)\s*[-–]\s*(\d+(?:[.,]\d+)?)/)
  const parse = (value: string) => Number(value.replace(",", "."))
  if (range) {
    const lo = parse(range[1]), hi = parse(range[2])
    return lo > 0 && hi >= lo ? (lo + hi) / 2 : null
  }
  const number = text.match(/\d+(?:[.,]\d+)?/)
  const value = number ? parse(number[0]) : 0
  return Number.isFinite(value) && value > 0 ? value : null
}

export function resolveServings(recipe: MealieRecipe): number | null {
  // Structured servings is authoritative; a yield can describe loaves, grams or jars.
  if (recipe.recipeServings != null && Number.isFinite(recipe.recipeServings) && recipe.recipeServings > 0) return recipe.recipeServings
  if (/\b(kg|g|gramm|grams|ml|liters?|liter)\b/i.test(recipe.recipeYield ?? "")) return null
  return parseYield(recipe.recipeYield)
}

export async function estimateRecipe(recipe: MealieRecipe): Promise<EstimateResult> {
  const matchedIngredients: IngredientMatch[] = []
  const unmatchedNames: string[] = []
  let totals = emptyAmounts()
  const warnings: string[] = []
  for (const ing of recipe.recipeIngredient) {
    const foodName = ing.food?.name
    const quantity = ing.quantity
    if (!foodName || quantity == null || !Number.isFinite(quantity) || quantity <= 0) {
      // Empty section headings are not ingredients; unparsed ingredient text is.
      const name = foodName || ing.display || ing.originalText || ing.original_text || ing.note
      if (!name && ing.title) continue
      const unmatchedName = name || "Unnamed ingredient"
      const reason = "invalid or unquantified ingredient"
      unmatchedNames.push(unmatchedName)
      matchedIngredients.push({ name: unmatchedName, grams: null, matched: false, nutrients: null, reason })
      warnings.push(`Skipped ${reason}: ${unmatchedName}`)
      continue
    }
    const context = interpretIngredient(ing, recipe.recipeInstructions)
    const unit = resolveUnitName(ing.unit)
    let grams = convertToGrams(quantity, ing.unit, context)
    let llmEstimated = false
    if (grams === null && unit && context.state !== "ambiguous") {
      grams = await estimateGrams(quantity, unit, context.query)
      llmEstimated = grams !== null
    }
    if (grams === null || !Number.isFinite(grams) || grams <= 0 || context.state === "ambiguous") {
      unmatchedNames.push(foodName)
      matchedIngredients.push({ name: foodName, grams: null, matched: false, nutrients: null, context, reason: context.state === "ambiguous" ? context.reason : "unknown weight" })
      logger.debug({ ...context, quantity, unit, grams }, "Ingredient could not be estimated")
      continue
    }
    let nutrients: NutrientSet | null = null
    let source: IngredientMatch["source"] = "OFF"
    let productName: string | null = null
    let confidence = "high"
    let reason = "table salt mass calculation"
    if (["salt", "water"].includes(context.canonicalName) && context.state === "unspecified") {
      nutrients = genericNutrients(context)
      source = "deterministic"
      reason = context.canonicalName === "water" ? "plain water zero-nutrient default" : reason
    } else if ((nutrients = genericNutrients(context)) !== null) {
      source = "generic"
      confidence = "medium"
      reason = "exact canonical identity and state; USDA reference preferred before OFF"
    } else {
      const off = await lookupNutrients(foodName, ing.unit?.name, context)
      nutrients = off.matched ? off.nutrients : null
      productName = off.productName
      confidence = off.confidence ?? "medium"
      reason = off.reason ?? "OFF lookup"
      if (!nutrients) {
        nutrients = await estimateNutrients(context.query, context)
        source = "LLM"
        confidence = "low"
        reason += "; no generic profile, LLM fallback"
        llmEstimated = true
      }
    }
    if (!nutrients || validateProfile(nutrients).length) {
      unmatchedNames.push(foodName)
      matchedIngredients.push({ name: foodName, grams, matched: false, nutrients: null, context, reason })
      logger.debug({ ...context, quantity, unit, grams, source, reason }, "No valid nutrient profile")
      continue
    }
    const contribution = amountsFromProfile(nutrients, grams)
    totals = addAmounts(totals, contribution)
    matchedIngredients.push({ name: foodName, grams, matched: true, nutrients, llmEstimated, source, context, productName, confidence, reason })
    logger.debug({ originalName: foodName, normalizedQuery: context.query, state: context.state, stateReason: context.reason,
      quantity, unit, grams, source, productName, confidence, reason, kcalPer100g: nutrients.kcalPer100g,
      sodiumMgPer100g: nutrients.sodiumPer100g, kcalContribution: contribution.kcal, sodiumMgContribution: contribution.sodiumMg,
    }, "Ingredient nutrition contribution")
  }
  const servings = resolveServings(recipe)
  const yieldServings = parseYield(recipe.recipeYield)
  if (servings && yieldServings && servings !== yieldServings) warnings.push("recipeServings takes precedence over conflicting recipeYield")
  if (!servings) warnings.push("No valid serving count; nutrition will not be written")
  if (unmatchedNames.length) warnings.push(`Partial estimate: ${unmatchedNames.join(", ")}`)
  const perServing = servings ? divideAmounts(totals, servings) : emptyAmounts()
  warnings.push(...recipeWarnings(perServing))
  for (const warning of warnings) logger.warn({ slug: recipe.slug, warning }, "Recipe nutrition warning")
  const result: EstimateResult = {
    slug: recipe.slug, servings, totals, perServing, warnings, partial: unmatchedNames.length > 0,
    totalNutrients: legacyAmounts(totals), perServingNutrients: legacyAmounts(perServing),
    matchedCount: matchedIngredients.filter(i => i.matched).length,
    unmatchedCount: unmatchedNames.length, unmatchedIngredients: unmatchedNames, matchedIngredients,
  }
  logger.info({ slug: recipe.slug, servings, totalKcal: totals.kcal, kcalPerServing: perServing.kcal,
    totalSodiumMg: totals.sodiumMg, sodiumMgPerServing: perServing.sodiumMg, warnings,
    matched: result.matchedCount, unmatched: result.unmatchedCount, partial: result.partial }, "Estimated nutrition for recipe")
  return result
}

export function hasManualCalories(recipe: MealieRecipe): boolean {
  const hasHash = recipe.extras?.calorie_estimator_hash != null
  const hasStoredNutrition =
    recipe.nutrition?.calories != null && recipe.nutrition.calories.trim().length > 0

  return !hasHash && hasStoredNutrition
}

export function buildManualAckPatch(recipe: MealieRecipe, hash: string): NutritionPatch {
  return {
    nutrition: {},
    extras: {
      calorie_estimator_hash: hash,
      calorie_estimator_unmatched: JSON.stringify([]),
      calorie_estimator_note: "Manual — preserved existing calorie entry",
    },
  }
}

function n(v: number | null): string {
  return v != null && Number.isFinite(v) ? (Math.round(v * 100) / 100).toString() : ""
}

export function isPartialEstimate(result: EstimateResult): boolean {
  return result.partial === true || result.unmatchedCount > 0 || result.unmatchedIngredients.length > 0
    || result.matchedIngredients.some(ingredient => !ingredient.matched)
}

export function buildNutritionPatch(
  result: EstimateResult,
  hash: string,
  recipeYield: string | null,
  existingNutrition?: MealieNutrition | null,
): NutritionPatch {
  const llmIngredients = result.matchedIngredients
    .filter((i) => i.llmEstimated)
    .map((i) => i.name)

  const partial = isPartialEstimate(result)
  const emptyExistingNutrition = existingNutrition === null || (existingNutrition !== undefined
    && Object.values(existingNutrition).every(value => value == null || value.trim() === ""))
  const withhold = partial && (config.estimate.partialPolicy !== "fill-empty" || !emptyExistingNutrition)
  const extras: Record<string, string> = {
    // Partial attempts must remain retryable, including when empty nutrition was filled.
    calorie_estimator_hash: partial ? "" : hash,
    calorie_estimator_attempt_hash: hash,
    calorie_estimator_partial: String(partial),
    calorie_estimator_partial_policy: config.estimate.partialPolicy,
    calorie_estimator_nutrition_status: withhold ? "partial-withheld" : partial ? "partial-written" : "complete",
    calorie_estimator_unmatched: JSON.stringify(result.unmatchedIngredients),
    calorie_estimator_unmatched_details: JSON.stringify(result.matchedIngredients.filter(ingredient => !ingredient.matched)
      .map(({ name, grams, reason }) => ({ name, grams, reason }))),
    calorie_estimator_warnings: JSON.stringify(result.warnings ?? []),
    calorie_estimator_partial_total_kcal: partial ? n(result.totalNutrients.kcalPer100g) : "",
  }

  if (llmIngredients.length > 0) {
    extras.calorie_estimator_llm_ingredients = JSON.stringify(llmIngredients)
  }

  const p = result.perServingNutrients
  const totalKcal = result.totalNutrients.kcalPer100g
  if (!partial && totalKcal !== null && totalKcal > 0) {
    extras.calorie_estimator_total_kcal = totalKcal.toString()
  }

  const servings = result.servings
  if (!partial && servings !== null) {
    extras.calorie_estimator_yield = servings.toString()
  }

  if (withhold) {
    logger.warn({ slug: result.slug, policy: config.estimate.partialPolicy, unmatched: result.unmatchedIngredients }, "Withholding partial nutrition; preserving existing Mealie values")
    return { nutrition: {}, extras }
  }

  const nutrition: Partial<MealieNutrition> = {}
  const add = (key: keyof MealieNutrition, val: string) => {
    if (val !== "") nutrition[key] = val
  }

  add("calories", p.kcalPer100g === null ? "" : n(Math.round(p.kcalPer100g)))
  add("proteinContent", n(p.proteinPer100g))
  add("carbohydrateContent", n(p.carbsPer100g))
  add("fatContent", n(p.fatPer100g))
  add("saturatedFatContent", n(p.saturatedFatPer100g))
  add("transFatContent", n(p.transFatPer100g))
  add("unsaturatedFatContent", n(p.unsaturatedFatPer100g))
  add("fiberContent", n(p.fiberPer100g))
  add("sugarContent", n(p.sugarPer100g))
  add("sodiumContent", p.sodiumPer100g === null ? "" : n(Math.round(p.sodiumPer100g)))
  add("cholesterolContent", p.cholesterolPer100g === null ? "" : n(Math.round(p.cholesterolPer100g)))

  const safeNutrition = sanitizeNutritionPatch(nutrition, result.slug)
  if (partial && Object.keys(safeNutrition).length === 0) extras.calorie_estimator_nutrition_status = "partial-withheld"
  return { nutrition: safeNutrition, extras }
}
