import type { NutrientSet } from "../types.js"

/** Bounds describe 100 g of food, not dietary targets. Includes salt, spices and organ meats. */
export function validateProfile(n: NutrientSet): string[] {
  const reasons: string[] = []
  for (const [key, value] of Object.entries(n)) {
    if (value === null) continue
    const limit = key === "kcalPer100g" ? 950 : key === "sodiumPer100g" ? 40000 : key === "cholesterolPer100g" ? 3500 : 100
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > limit) reasons.push(`invalid ${key}`)
  }
  if (n.kcalPer100g == null) reasons.push("missing energy")
  if (n.fatPer100g != null && (n.saturatedFatPer100g ?? 0) + (n.transFatPer100g ?? 0) > n.fatPer100g + 0.5) reasons.push("fat fractions exceed total fat")
  if (n.carbsPer100g != null && (n.sugarPer100g ?? 0) > n.carbsPer100g + 2) reasons.push("sugar exceeds carbohydrates")
  if ((n.carbsPer100g ?? 0) + (n.fiberPer100g ?? 0) > 105) reasons.push("carbohydrate and fiber exceed food mass")
  if ((n.proteinPer100g ?? 0) + (n.carbsPer100g ?? 0) + (n.fatPer100g ?? 0) > 105) reasons.push("macros exceed food mass")
  if (n.kcalPer100g != null && n.proteinPer100g != null && n.carbsPer100g != null && n.fatPer100g != null) {
    const energy = n.proteinPer100g * 4 + n.carbsPer100g * 4 + n.fatPer100g * 9 + (n.fiberPer100g ?? 0) * 2
    // Wide allowance for fiber, alcohol, food-specific Atwater factors and label rounding.
    if (Math.abs(n.kcalPer100g - energy) > Math.max(100, energy * 0.4)) reasons.push("energy disagrees with macros")
  }
  return reasons
}

import type { NutrientAmounts } from "./nutrient-amounts.js"
import type { MealieNutrition } from "../types.js"
import { logger } from "../utils/logger.js"

export function recipeWarnings(n: NutrientAmounts): string[] {
  const warnings: string[] = []
  if ((n.kcal ?? 0) > 3000) warnings.push("Calories exceed 3000 kcal per serving; verify yield and quantities")
  if ((n.sodiumMg ?? 0) > 5000) warnings.push("Sodium exceeds 5000 mg per serving; verify salt and portions")
  for (const [key, value] of Object.entries(n)) if (value != null && (!Number.isFinite(value) || value < 0)) warnings.push(`Invalid recipe amount: ${key}`)
  if (n.kcal != null && n.proteinG != null && n.carbsG != null && n.fatG != null) {
    const energy = n.proteinG * 4 + n.carbsG * 4 + n.fatG * 9 + (n.fiberG ?? 0) * 2
    if (Math.abs(n.kcal - energy) > Math.max(100, energy * 0.4)) warnings.push("Recipe calories disagree with macros")
  }
  return warnings
}

export function sanitizeNutritionPatch(nutrition: Partial<MealieNutrition>, slug: string): Partial<MealieNutrition> {
  const result = { ...nutrition }
  for (const [key, value] of Object.entries(result)) {
    const amount = Number(value)
    const hardLimit = key === "calories" ? 10000 : key === "sodiumContent" ? 40000 : key === "cholesterolContent" ? 10000 : 2000
    if (!Number.isFinite(amount) || amount < 0 || amount > hardLimit) {
      logger.warn({ slug, nutrient: key, value }, "Omitting implausible nutrient from Mealie patch")
      delete result[key as keyof MealieNutrition]
    }
  }
  return result
}
