import crypto from "node:crypto"
import type { NutrientSet, MealieNutrition } from "../types.js"

/**
 * Parses Mealie's stored nutrition strings back into the engine's internal NutrientSet
 * representation. sodiumContent/cholesterolContent are stored in Mealie as milligrams
 * (schema.org NutritionInformation convention); every other field is grams. NutrientSet keeps
 * all fields in grams internally, matching the provider layer, so sodium/cholesterol are
 * converted back here.
 */
export function perServingFromRecipeNutrition(nutrition: MealieNutrition | null): NutrientSet {
  if (!nutrition) {
    return {
      kcalPer100g: null, proteinPer100g: null, carbsPer100g: null,
      fatPer100g: null, saturatedFatPer100g: null, transFatPer100g: null,
      unsaturatedFatPer100g: null, fiberPer100g: null, sugarPer100g: null,
      sodiumPer100g: null, cholesterolPer100g: null,
    }
  }

  const p = (v: string | null): number | null => {
    if (v === null || v.trim() === "") return null
    const n = Number.parseFloat(v)
    return Number.isNaN(n) ? null : n
  }

  const pMg = (v: string | null): number | null => {
    const mg = p(v)
    return mg !== null ? mg / 1000 : null
  }

  return {
    kcalPer100g: p(nutrition.calories),
    proteinPer100g: p(nutrition.proteinContent),
    carbsPer100g: p(nutrition.carbohydrateContent),
    fatPer100g: p(nutrition.fatContent),
    saturatedFatPer100g: p(nutrition.saturatedFatContent),
    transFatPer100g: p(nutrition.transFatContent),
    unsaturatedFatPer100g: p(nutrition.unsaturatedFatContent),
    fiberPer100g: p(nutrition.fiberContent),
    sugarPer100g: p(nutrition.sugarContent),
    sodiumPer100g: pMg(nutrition.sodiumContent),
    cholesterolPer100g: pMg(nutrition.cholesterolContent),
  }
}

/**
 * Fingerprints a NutrientSet exactly as the estimator wrote it, so a later run can tell whether
 * the same values are still present (estimator-owned, safe to overwrite) or have since been
 * hand-edited by a person (protect them). Deliberately deterministic and field-order-stable.
 */
export function computeNutritionFingerprint(nutrients: NutrientSet): string {
  const parts = [
    nutrients.kcalPer100g, nutrients.proteinPer100g, nutrients.carbsPer100g, nutrients.fatPer100g,
    nutrients.saturatedFatPer100g, nutrients.transFatPer100g, nutrients.unsaturatedFatPer100g,
    nutrients.fiberPer100g, nutrients.sugarPer100g, nutrients.sodiumPer100g, nutrients.cholesterolPer100g,
  ].map((v) => (v === null ? "" : v.toString()))
  return crypto.createHash("sha256").update(parts.join("|")).digest("hex")
}
