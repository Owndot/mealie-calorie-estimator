import type { NutrientSet } from "../types.js"
import { contextForName, interpretIngredient, normalizeFoodText, type IngredientContext } from "./ingredient-context.js"
import { genericNutrients } from "./generic-foods.js"

export function scoreOffMatch(context: IngredientContext, productName: string, nutrients?: NutrientSet, brands?: string): number {
  let candidateName = productName
  let wantedName = context.canonicalName
  if (context.brand) {
    const brand = normalizeFoodText(context.brand)
    const hasBrand = (text: string) => (` ${normalizeFoodText(text)} `).includes(` ${brand} `)
    if (!hasBrand(productName) && !hasBrand(brands ?? "")) return 0
    candidateName = (` ${normalizeFoodText(productName)} `).replace(` ${brand} `, " ").trim()
    wantedName = (` ${normalizeFoodText(wantedName)} `).replace(` ${brand} `, " ").trim()
  }
  const candidate = interpretIngredient({ food: { id: "", name: candidateName, pluralName: null, aliases: [] } }, [], false)
  if (!context.canonicalName || candidate.canonicalName !== wantedName || context.state === "ambiguous" || candidate.state === "ambiguous") return 0
  const requiredDescriptors = (context.descriptorNotes ?? []).filter(note => ["in oil", "in brine", "pickled"].includes(note))
  if (requiredDescriptors.some(note => !(candidate.descriptorNotes ?? []).includes(note))) return 0
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
