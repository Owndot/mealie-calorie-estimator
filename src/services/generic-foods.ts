import data from "../nutrition-data/generic-foods.js"
import type { NutrientSet } from "../types.js"
import { normalizeFoodText, type FoodState, type IngredientContext } from "./ingredient-context.js"

export interface GenericEntry { category: string; synonyms: string[]; fdcId: string; description: string; nutrients: NutrientSet; portions: Array<{ description: string; amount: number; grams: number }> }
const foods: Record<string, GenericEntry> = data
const SALT: NutrientSet = {
  kcalPer100g: 0, proteinPer100g: 0, carbsPer100g: 0, fatPer100g: 0,
  saturatedFatPer100g: 0, transFatPer100g: 0, unsaturatedFatPer100g: 0,
  fiberPer100g: 0, sugarPer100g: 0, sodiumPer100g: 39300, cholesterolPer100g: 0,
}
// Plain water: zero energy/macros; sodium defaults to zero when mineral content is unknown.
// Branded/mineral/flavoured waters retain their own database/LLM lookup path.
const WATER: NutrientSet = { ...SALT, sodiumPer100g: 0 }
export interface GenericMatch { key: string; name: string; state: FoodState; entry: GenericEntry; confidence: number }
export const genericCatalog = Object.entries(foods).map(([key, entry]) => ({
  key, name: key.split(":")[0], state: key.split(":")[1] as FoodState, entry,
}))

function tokens(name: string): string[] {
  return normalizeFoodText(name).split(" ").map(word => word.length > 3 && word.endsWith("s") ? word.slice(0, -1) : word).sort()
}
function editDistance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 0; i < a.length; i++) {
    const next = [i + 1]
    for (let j = 0; j < b.length; j++) next.push(Math.min(next[j] + 1, row[j + 1] + 1, row[j] + (a[i] === b[j] ? 0 : 1)))
    row = next
  }
  return row[b.length]
}
function nameScore(a: string, b: string): number {
  const left = tokens(a), right = tokens(b)
  if (left.join(" ") === right.join(" ")) return 1
  // All identity tokens must match; no substring matching of oil, drink, seed or sauce.
  if (left.length !== right.length) return 0
  return left.every((word, i) => word === right[i] || (Math.min(word.length, right[i].length) >= 6 && editDistance(word, right[i]) <= 1)) ? 0.9 : 0
}
function stateCompatible(requested: FoodState, actual: FoodState, category: string): boolean {
  if (requested === actual) return true
  if (requested === "unspecified") return false
  const freshLike = ["raw", "fresh"]
  if (freshLike.includes(requested) && freshLike.includes(actual)
    && ["vegetable", "fruit", "herb", "nut_seed"].includes(category)) return true
  return false
}
export function matchGenericFood(context: IngredientContext, allowDefault = false): GenericMatch | null {
  if (context.brand || context.state === "ambiguous") return null
  let name = context.canonicalName
  if (name === "basmati rice") name = "rice" // Long-grain white rice proxy.
  if (name === "red onion") name = "onion"
  const state = name === "coconut milk" && context.state === "canned" ? "unspecified" : context.state
  const candidates = genericCatalog.flatMap(item => {
    const confidence = Math.max(...[item.name, ...item.entry.synonyms].map(value => nameScore(name, value)))
    const defaultState = allowDefault && state === "unspecified" && (
      (["vegetable", "fruit", "nut_seed"].includes(item.entry.category) && item.state === "raw")
      || (["grain", "legume"].includes(item.entry.category) && item.state === "dry")
      || (item.entry.category === "herb" && item.state === "fresh"))
    return confidence >= 0.9 && (stateCompatible(state, item.state, item.entry.category) || defaultState)
      ? [{ ...item, confidence }] : []
  }).sort((a, b) => b.confidence - a.confidence)
  if (!candidates[0] || (candidates[1] && candidates[0].confidence - candidates[1].confidence < 0.05)) return null
  return candidates[0]
}
export function genericEntry(context: IngredientContext): GenericEntry | undefined {
  return matchGenericFood(context)?.entry
}
export function genericNutrients(context: IngredientContext): NutrientSet | null {
  if (context.brand) return null
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
