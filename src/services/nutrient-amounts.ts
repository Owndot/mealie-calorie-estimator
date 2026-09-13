import type { NutrientSet } from "../types.js"

/** Absolute amounts for a whole recipe or one serving; no implicit per-100-g basis. */
export interface NutrientAmounts {
  kcal: number | null
  proteinG: number | null
  carbsG: number | null
  fatG: number | null
  saturatedFatG: number | null
  transFatG: number | null
  unsaturatedFatG: number | null
  fiberG: number | null
  sugarG: number | null
  sodiumMg: number | null
  cholesterolMg: number | null
}
export type RecipeNutrientTotals = NutrientAmounts
export type PerServingNutrition = NutrientAmounts
const fields = {
  kcal: "kcalPer100g", proteinG: "proteinPer100g", carbsG: "carbsPer100g", fatG: "fatPer100g",
  saturatedFatG: "saturatedFatPer100g", transFatG: "transFatPer100g", unsaturatedFatG: "unsaturatedFatPer100g",
  fiberG: "fiberPer100g", sugarG: "sugarPer100g", sodiumMg: "sodiumPer100g", cholesterolMg: "cholesterolPer100g",
} as const
export function amountsFromProfile(profile: NutrientSet, grams: number): NutrientAmounts {
  return Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, profile[field] === null ? null : profile[field]! * grams / 100])) as unknown as NutrientAmounts
}
export function emptyAmounts(): NutrientAmounts {
  return Object.fromEntries(Object.keys(fields).map(key => [key, null])) as unknown as NutrientAmounts
}
export function addAmounts(total: NutrientAmounts, part: NutrientAmounts): NutrientAmounts {
  return Object.fromEntries((Object.keys(fields) as Array<keyof NutrientAmounts>).map(key => [key,
    total[key] === null && part[key] === null ? null : (total[key] ?? 0) + (part[key] ?? 0),
  ])) as unknown as NutrientAmounts
}
export function divideAmounts(total: NutrientAmounts, servings: number): NutrientAmounts {
  return Object.fromEntries(Object.entries(total).map(([key, value]) => [key, value === null ? null : value / servings])) as unknown as NutrientAmounts
}
/** Compatibility adapter for existing estimator API consumers. Sodium/cholesterol are now mg. */
export function legacyAmounts(amounts: NutrientAmounts): NutrientSet {
  return Object.fromEntries(Object.entries(fields).map(([key, field]) => [field, amounts[key as keyof NutrientAmounts]])) as unknown as NutrientSet
}
