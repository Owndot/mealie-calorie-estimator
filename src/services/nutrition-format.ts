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

const NUTRITION_FIELD_ORDER: (keyof MealieNutrition)[] = [
  "calories", "proteinContent", "carbohydrateContent", "fatContent",
  "saturatedFatContent", "transFatContent", "unsaturatedFatContent",
  "fiberContent", "sugarContent", "sodiumContent", "cholesterolContent",
]

/**
 * Fingerprints nutrition in Mealie's own string/milligram representation — the same shape as
 * both the `nutrition` patch object actually sent to Mealie and the `recipe.nutrition` read back
 * from it later. Operating on these raw strings (rather than round-tripping through the internal
 * NutrientSet, which involves float division and milligram rounding) avoids spurious mismatches:
 * a value that was never touched compares bit-for-bit equal, with no precision loss anywhere in
 * the path. A later run can then tell "still ours, safe to overwrite" apart from "a person
 * edited this by hand".
 */
export function computeNutritionFingerprint(nutrition: Partial<Record<keyof MealieNutrition, string | null>>): string {
  const parts = NUTRITION_FIELD_ORDER.map((key) => (nutrition[key] ?? "").toString().trim())
  return crypto.createHash("sha256").update(parts.join("|")).digest("hex")
}
