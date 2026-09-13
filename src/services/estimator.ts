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
  const parts: string[] = [NUTRITION_VERSION, `pinch:${config.units.pinchGrams}`]

  for (const ing of recipe.recipeIngredient) {
    const qty = ing.quantity ?? 0
    const unitName = ing.unit?.name ?? ""
    const foodName = ing.food?.name ?? ""
    parts.push(JSON.stringify([qty, unitName, foodName, ing.unit, ing.note, ing.originalText, ing.original_text, ing.display]))
  }

  parts.sort()
  parts.push(JSON.stringify(recipe.recipeInstructions ?? []))
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
      warnings.push(`Skipped invalid or unquantified ingredient: ${foodName || ing.display}`)
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
    if (context.canonicalName === "salt" && context.state === "unspecified") {
      nutrients = genericNutrients(context)
      source = "deterministic"
    } else {
      const off = await lookupNutrients(foodName, ing.unit?.name, context)
      nutrients = off.matched ? off.nutrients : null
      productName = off.productName
      confidence = off.confidence ?? "medium"
      reason = off.reason ?? "OFF lookup"
      if (!nutrients) {
        nutrients = genericNutrients(context)
        source = "generic"
        confidence = "medium"
        reason += "; state-specific USDA reference fallback"
      }
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
    slug: recipe.slug, servings, totals, perServing, warnings,
    totalNutrients: legacyAmounts(totals), perServingNutrients: legacyAmounts(perServing),
    matchedCount: matchedIngredients.filter(i => i.matched).length,
    unmatchedCount: unmatchedNames.length, unmatchedIngredients: unmatchedNames, matchedIngredients,
  }
  logger.info({ slug: recipe.slug, servings, totalKcal: totals.kcal, kcalPerServing: perServing.kcal,
    totalSodiumMg: totals.sodiumMg, sodiumMgPerServing: perServing.sodiumMg, warnings,
    matched: result.matchedCount, unmatched: result.unmatchedCount }, "Estimated nutrition for recipe")
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

export function buildNutritionPatch(
  result: EstimateResult,
  hash: string,
  recipeYield: string | null,
): NutritionPatch {
  const llmIngredients = result.matchedIngredients
    .filter((i) => i.llmEstimated)
    .map((i) => i.name)

  const extras: Record<string, string> = {
    calorie_estimator_hash: hash,
    calorie_estimator_unmatched: JSON.stringify(result.unmatchedIngredients),
  }

  if (llmIngredients.length > 0) {
    extras.calorie_estimator_llm_ingredients = JSON.stringify(llmIngredients)
  }

  const p = result.perServingNutrients
  const totalKcal = result.totalNutrients.kcalPer100g
  if (totalKcal !== null && totalKcal > 0) {
    extras.calorie_estimator_total_kcal = totalKcal.toString()
  }

  const servings = result.servings
  if (servings !== null) {
    extras.calorie_estimator_yield = servings.toString()
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

  if (result.warnings?.length) extras.calorie_estimator_warnings = JSON.stringify(result.warnings)
  return { nutrition: sanitizeNutritionPatch(nutrition, result.slug), extras }
}
