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
  if (n.carbsPer100g != null && (n.sugarPer100g ?? 0) > n.carbsPer100g + 0.5) reasons.push("sugar exceeds carbohydrates")
  if ((n.carbsPer100g ?? 0) + (n.fiberPer100g ?? 0) > 105) reasons.push("carbohydrate and fiber exceed food mass")
  if ((n.proteinPer100g ?? 0) + (n.carbsPer100g ?? 0) + (n.fatPer100g ?? 0) > 105) reasons.push("macros exceed food mass")
  if (n.kcalPer100g != null && n.proteinPer100g != null && n.carbsPer100g != null && n.fatPer100g != null) {
    const energy = n.proteinPer100g * 4 + n.carbsPer100g * 4 + n.fatPer100g * 9
    // Wide allowance for fiber, alcohol, food-specific Atwater factors and label rounding.
    if (Math.abs(n.kcalPer100g - energy) > Math.max(100, energy * 0.4)) reasons.push("energy disagrees with macros")
  }
  return reasons
}
