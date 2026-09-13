import { normalizeRecipe, normalizedContext, normalizedGrams, ingredientText, NORMALIZATION_VERSION } from "./recipe-normalizer.js"
import { resolveNutrition } from "./nutrition-providers.js"
import { buildUnresolvedFoodContext, interpretSemanticIngredient, INTERPRETATION_VERSION } from "./ingredient-interpreter.js"
import { interpretIngredient, NUTRITION_VERSION } from "./ingredient-context.js"

import { emptyAmounts, addAmounts, amountsFromProfile, divideAmounts, legacyAmounts } from "./nutrient-amounts.js"
import { recipeWarnings, sanitizeNutritionPatch, validateCompleteProfile, validateProfile } from "./nutrition-validation.js"
import crypto from "node:crypto"
import type {
  MealieRecipe, IngredientMatch, EstimateResult, NutritionPatch,
  MealieNutrition,
} from "../types.js"
import { config } from "../config.js"
import { convertToGrams, hasImpossibleVolumeStandard, resolveUnitName } from "./unit-converter.js"

import { estimateGrams } from "./llm-estimator.js"
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
    NUTRITION_VERSION, INTERPRETATION_VERSION, NORMALIZATION_VERSION, config.llm.normalizeRecipe, config.estimate.autoTags, "input-hash-v4-pipeline",
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
  const normalized = await normalizeRecipe(recipe)
  for (const [index, ing] of recipe.recipeIngredient.entries()) {
    try {
      const row = normalized?.[index]
      const foodName = ing.food?.name || (row ? ingredientText(ing) : undefined)
      const quantity = row ? normalizedGrams(row, ing).grams : ing.quantity
      if (!foodName || quantity == null || !Number.isFinite(quantity) || quantity <= 0) {
        const tasteOnly = Boolean(foodName && /\b(?:nach\s+geschmack|nach\s+bedarf|to\s+taste|as\s+needed|as\s+desired)\b/i.test(
          [foodName, ing.note, ing.display, ing.originalText, ing.original_text].filter(Boolean).join(" "),
        ))
        if (tasteOnly && foodName) {
          const zero = emptyAmounts()
          matchedIngredients.push({ name: foodName, grams: 0, matched: true, nutrients: {
            kcalPer100g: 0, proteinPer100g: 0, carbsPer100g: 0, fatPer100g: 0,
            saturatedFatPer100g: 0, transFatPer100g: 0, unsaturatedFatPer100g: 0,
            fiberPer100g: 0, sugarPer100g: 0, sodiumPer100g: 0, cholesterolPer100g: 0,
          }, source: "deterministic", confidence: "medium", interpretationConfidence: 0.9,
          sourceConfidence: 0.9, finalMatchConfidence: 0.9, reason: "to-taste seasoning omitted from quantified nutrition" })
          totals = addAmounts(totals, zero)
          warnings.push(`No measurable quantity for seasoning: ${foodName}`)
          continue
        }
        // Empty section headings are not ingredients; unparsed ingredient text is.
        const name = foodName || ing.display || ing.originalText || ing.original_text || ing.note
        if (!name && ing.title) continue
        const unmatchedName = name || "Unnamed ingredient"
        const reason = "invalid or unquantified ingredient"
        unmatchedNames.push(unmatchedName)
        matchedIngredients.push({ name: unmatchedName, grams: null, matched: false, nutrients: null, interpretationConfidence: 0, sourceConfidence: 0, finalMatchConfidence: 0, reason })
        warnings.push(`Skipped ${reason}: ${unmatchedName}`)
        continue
      }
      const interpretedContext = row ? normalizedContext(row, ing) : await interpretSemanticIngredient(ing, recipe.recipeInstructions)
      const context = interpretedContext ?? buildUnresolvedFoodContext(interpretIngredient(ing, recipe.recipeInstructions))
      logger.debug({
        originalName: foodName,
        interpretationStatus: interpretedContext ? "resolved" : context ? "safe-unresolved" : "rejected",
        interpretationSource: context?.interpretationSource,
        canonicalName: context?.canonicalName,
        state: context?.state,
      }, "Ingredient interpretation status")
      if (!context) {
        unmatchedNames.push(foodName)
        matchedIngredients.push({ name: foodName, grams: null, matched: false, nutrients: null,
          interpretationConfidence: 0, sourceConfidence: 0, finalMatchConfidence: 0, reason: "ambiguous, contradictory, or non-food ingredient interpretation" })
        logger.debug({ originalName: foodName, quantity, unit: ing.unit?.name, finalRejectionReason: "unsafe or non-food interpretation" }, "Ingredient rejected")
        continue
      }
      const unit = resolveUnitName(ing.unit)
      let grams = row ? normalizedGrams(row, ing).grams : convertToGrams(quantity, ing.unit, context)
      let llmEstimated = false
      let weightEstimated = row ? normalizedGrams(row, ing).estimated : !["gram", "kilogram", "milligram", "ounce", "pound"].includes(unit ?? "")
      if (grams === null && unit && !hasImpossibleVolumeStandard(ing.unit) && context.state !== "ambiguous") {
        grams = await estimateGrams(quantity, unit, context.query)
        llmEstimated = grams !== null
        weightEstimated = llmEstimated
      }
      if (grams === null || !Number.isFinite(grams) || grams <= 0 || context.state === "ambiguous") {
        unmatchedNames.push(foodName)
        matchedIngredients.push({ name: foodName, grams: null, matched: false, nutrients: null, context, interpretationConfidence: context.interpretationConfidence, sourceConfidence: 0, finalMatchConfidence: 0, reason: context.state === "ambiguous" ? context.reason : "unknown weight" })
        logger.debug({ ...context, quantity, unit, grams, interpretationStatus: context.interpretationSource, weightResolutionStatus: "rejected", finalRejectionReason: "quantity or unit could not be resolved" }, "Ingredient could not be estimated")
        continue
      }
      logger.debug({ originalName: foodName, grams, unit, interpretationStatus: context.interpretationSource, weightResolutionStatus: weightEstimated ? "llm-estimated" : "deterministic" }, "Ingredient weight resolution status")
      const resolved = await resolveNutrition(context)
      const nutrients = resolved?.nutrients ?? null
      const source = resolved?.source
      const productName = resolved?.productName ?? null
      const sourceConfidence = resolved?.confidence ?? 0
      const confidence = sourceConfidence >= 0.9 ? "high" : sourceConfidence >= 0.75 ? "medium" : "low"
      const reason = resolved?.reason ?? "no valid nutrient profile"
      llmEstimated ||= source === "LLM" || resolved?.originalSource === "LLM"
      if (weightEstimated) warnings.push(`Quantity estimated: ${foodName}`)
      const interpretationConfidence = context.interpretationConfidence ?? 0.85
      const weightConfidence = weightEstimated ? 0.7 : 1
      const finalMatchConfidence = Math.min(interpretationConfidence, sourceConfidence, weightConfidence)

      const validationErrors = source === "LLM" ? validateCompleteProfile(nutrients ?? {
        kcalPer100g: null, proteinPer100g: null, carbsPer100g: null, fatPer100g: null,
        saturatedFatPer100g: null, transFatPer100g: null, unsaturatedFatPer100g: null,
        fiberPer100g: null, sugarPer100g: null, sodiumPer100g: null, cholesterolPer100g: null,
      }) : nutrients ? validateProfile(nutrients) : ["missing nutrient profile"]
      if (!nutrients || validationErrors.length) {
        unmatchedNames.push(foodName)
        matchedIngredients.push({ name: foodName, grams, matched: false, nutrients: null, context, interpretationConfidence, sourceConfidence: 0, finalMatchConfidence: 0, reason: `${reason}; ${validationErrors.join(", ")}` })
        logger.debug({ ...context, quantity, unit, grams, source, reason, nutrientResolutionStatus: nutrients ? "invalid" : "unresolved", finalRejectionReason: reason }, "No valid nutrient profile")
        continue
      }
      logger.debug({ originalName: foodName, interpretationStatus: context.interpretationSource, weightResolutionStatus: weightEstimated ? "llm-estimated" : "deterministic", nutrientResolutionStatus: source, finalRejectionReason: null }, "Ingredient resolution status")
      const contribution = amountsFromProfile(nutrients, grams)
      totals = addAmounts(totals, contribution)
      matchedIngredients.push({ name: foodName, grams, matched: true, nutrients, llmEstimated, estimatedAmount: weightEstimated, originalSource: resolved?.originalSource, resolvedAt: resolved?.timestamp, source, context, productName, confidence, interpretationConfidence, sourceConfidence, finalMatchConfidence, weightConfidence, profileId: resolved?.profileId, reason })
      logger.debug({ originalName: foodName, canonicalFood: context.canonicalName, interpretationSource: context.interpretationSource, category: context.category, normalizedQuery: context.query, state: context.state, stateReason: context.reason,
        quantity, unit, grams, source, productName, confidence, reason, kcalPer100g: nutrients.kcalPer100g,
        sodiumMgPer100g: nutrients.sodiumPer100g, kcalContribution: contribution.kcal, sodiumMgContribution: contribution.sodiumMg, macroContributions: contribution, generic: context.generic, brand: context.brand,
        interpretationConfidence, sourceConfidence, finalMatchConfidence, weightConfidence, profileId: resolved?.profileId,
      }, "Ingredient nutrition contribution")
    } catch (error) {
      const name = ingredientText(ing) || "Unnamed ingredient"
      unmatchedNames.push(name)
      matchedIngredients.push({ name, grams: null, matched: false, nutrients: null, reason: "ingredient processing failed" })
      warnings.push(`Ingredient processing failed: ${name}`)
      logger.warn({ error, name }, "Continuing after ingredient failure")
    }
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
    sources: Object.fromEntries([...new Set(matchedIngredients.map(i => i.source).filter(Boolean))].map(source => [source, matchedIngredients.filter(i => i.source === source).length])),
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
