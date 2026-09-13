import data from "../nutrition-data/generic-foods.js"
import type { NutrientSet } from "../types.js"
import type { IngredientContext } from "./ingredient-context.js"

interface GenericEntry { fdcId: string; description: string; nutrients: NutrientSet; portions: Array<{ description: string; amount: number; grams: number }> }
const foods: Record<string, GenericEntry> = data
const SALT: NutrientSet = {
  kcalPer100g: 0, proteinPer100g: 0, carbsPer100g: 0, fatPer100g: 0,
  saturatedFatPer100g: 0, transFatPer100g: 0, unsaturatedFatPer100g: 0,
  fiberPer100g: 0, sugarPer100g: 0, sodiumPer100g: 39300, cholesterolPer100g: 0,
}
// Plain water: zero energy/macros; sodium defaults to zero when mineral content is unknown.
// Branded/mineral/flavoured waters retain their own database/LLM lookup path.
const WATER: NutrientSet = { ...SALT, sodiumPer100g: 0 }
export function genericEntry(context: IngredientContext): GenericEntry | undefined {
  let name = context.canonicalName
  if (name === "basmati rice") name = "rice" // Explicit long-grain white rice proxy.
  if (name === "red onion") name = "onion"
  let state = context.state
  if (name === "coconut milk" && state === "canned") state = "unspecified"
  return foods[`${name}:${state}`]
}
export function genericNutrients(context: IngredientContext): NutrientSet | null {
  if (context.canonicalName === "salt" && context.state === "unspecified") return { ...SALT }
  if (context.canonicalName === "water" && context.state === "unspecified") return { ...WATER }
  const entry = genericEntry(context)
  return entry ? { ...entry.nutrients } : null
}

/** Approximate edible weights, not package weights. USDA measures where available. */
export function knownGramsPerUnit(context: IngredientContext, unit: string): number | null {
  if (context.state === "ambiguous") return null
  if (context.canonicalName === "water") return ({ teaspoon: 5, tablespoon: 15, cup: 240, milliliter: 1, liter: 1000 } as Record<string, number>)[unit] ?? null
  if (context.canonicalName === "salt") {
    if (unit === "teaspoon") return 6
    if (unit === "tablespoon") return 18
    if (unit === "milliliter") return 1.2
  }
  const entry = genericEntry(context)
  if (!entry) return null
  if (unit === "piece" || unit === "clove") {
    const portion = entry.portions.find(p => unit === "clove" ? p.description === "clove" : p.description.startsWith("medium"))
    return portion ? portion.grams / portion.amount : null
  }
  const ml = unit === "teaspoon" ? 5 : unit === "tablespoon" ? 15 : unit === "cup" ? 240 : unit === "milliliter" ? 1 : unit === "liter" ? 1000 : null
  if (ml === null) return null
  const spoon = entry.portions.find(p => p.description === (unit === "tablespoon" ? "tbsp" : "tsp"))
    ?? entry.portions.find(p => /^(tsp|tbsp)(,|$)/.test(p.description))
  if (spoon) return ml * spoon.grams / spoon.amount / (spoon.description.startsWith("tbsp") ? 15 : 5)
  const cup = entry.portions.find(p => p.description === "cup")
  return cup ? ml * cup.grams / cup.amount / 240 : null
}
