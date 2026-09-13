import type { NutrientSet } from "../types.js"
import { contextForName, interpretIngredient, type IngredientContext } from "./ingredient-context.js"
import { genericNutrients } from "./generic-foods.js"

export function scoreOffMatch(context: IngredientContext, productName: string, nutrients?: NutrientSet): number {
  const candidate = interpretIngredient({ food: { id: "", name: productName, pluralName: null, aliases: [] } }, [], false)
  if (!context.canonicalName || candidate.canonicalName !== context.canonicalName || context.state === "ambiguous" || candidate.state === "ambiguous") return 0
  const wanted = context.state
  const found = candidate.state
  if (wanted !== found && found !== "unspecified") {
    if (![wanted, found].every(s => ["raw", "fresh"].includes(s)) && !(context.canonicalName === "coconut milk" && wanted === "unspecified" && found === "canned")) return 0
  }
  if (found === "unspecified" && ["cooked", "canned", "drained", "frozen"].includes(wanted)) return 0
  const reference = genericNutrients(context)
  if (reference?.kcalPer100g && nutrients?.kcalPer100g != null) {
    const ratio = nutrients.kcalPer100g / reference.kcalPer100g
    if (ratio < 0.65 || ratio > 1.5) return 0
  }
  if (reference && nutrients?.sodiumPer100g != null && nutrients.sodiumPer100g > Math.max(1000, (reference.sodiumPer100g ?? 0) * 5)) return 0
  if (wanted === "dry" && found === "unspecified" && !reference) return 0
  return wanted === found ? 100 : 85
}

export function isSuitableOffMatch(foodName: string, productName: string | undefined): boolean {
  return !!productName && scoreOffMatch(contextForName(foodName), productName) >= 80
}
