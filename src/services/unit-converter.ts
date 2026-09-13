import { config } from "../config.js"
import { knownGramsPerUnit } from "./generic-foods.js"
import type { IngredientContext } from "./ingredient-context.js"
import type { MealieUnit } from "../types.js"

const UNIT_ALIASES: Record<string, string[]> = {
  cup: ["cups", "tasse", "tassen"],
  tablespoon: ["tablespoons", "tbsp", "el", "essl", "essloeffel"],
  teaspoon: ["teaspoons", "tsp", "tl", "teel", "teeloeffel"],
  milliliter: ["milliliters", "millilitre", "millilitres", "ml"],
  liter: ["liters", "litre", "litres", "l"],
  gram: ["grams", "gramm", "gramms", "g"],
  milligram: ["milligrams", "milligramm", "mg"],
  kilogram: ["kilograms", "kilogramm", "kg"],
  ounce: ["ounces", "oz"],
  pound: ["pounds", "lb", "lbs"],
  pinch: ["pinches", "prise", "prisen"],
  dash: ["dashes"],
  clove: ["cloves", "zehe", "zehen"],
  piece: ["pieces", "stk", "stueck", "stuecke", "stuecken"],
  slice: ["slices"],
}

const aliases = new Map(Object.entries(UNIT_ALIASES).flatMap(([canonical, variants]) =>
  [canonical, ...variants].map(variant => [variant, canonical] as const),
))

// Legacy no-context callers retain volume approximations. Recipe estimation supplies context and requires known density.
const GRAMS_PER_UNIT = new Map<string, number | null>([
  ["cup", 240], ["tablespoon", 15], ["teaspoon", 5],
  ["milliliter", 1], ["liter", 1000], ["gram", 1], ["milligram", 0.001], ["kilogram", 1000],
  ["ounce", 28.35], ["pound", 453.592], ["pinch", null],
  ["dash", 0.3], ["clove", 5], ["piece", null], ["slice", null],
])

const STANDARD_UNITS = new Set(["milligram", "gram", "kilogram", "milliliter", "liter", "ounce", "pound"])

export function normalizeUnitName(name: string): string {
  const key = name.normalize("NFC").toLowerCase().trim().replace(/\./g, "")
    .replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
  return aliases.get(key) ?? name.trim()
}

export function resolveUnitName(unit: MealieUnit | null): string | null {
  const candidates = [unit?.name, unit?.abbreviation]
    .filter((name): name is string => name != null && name.trim().length > 0)
    .map(normalizeUnitName)
  return candidates.find(name => GRAMS_PER_UNIT.has(name)) ?? candidates[0] ?? null
}

export function hasImpossibleVolumeStandard(unit: MealieUnit | null): boolean {
  const input = resolveUnitName(unit)
  if (!unit || (input !== "milliliter" && input !== "liter") || unit.standardQuantity == null || unit.standardUnit == null) return false
  const standard = normalizeUnitName(unit.standardUnit)
  if (standard !== "gram" && standard !== "kilogram") return false
  const gramsPerInput = unit.standardQuantity * (standard === "kilogram" ? 1000 : 1)
  return !Number.isFinite(gramsPerInput) || gramsPerInput < 0.2 || gramsPerInput > 3.5
}

export function convertToGrams(quantity: number, unit: MealieUnit | null, context?: IngredientContext): number | null {
  if (!Number.isFinite(quantity) || quantity <= 0) return null
  const inputName = resolveUnitName(unit)
  if (unit?.standardQuantity != null && unit.standardUnit != null) {
    const standardUnit = normalizeUnitName(unit.standardUnit)
    if (Number.isFinite(unit.standardQuantity) && unit.standardQuantity > 0 && STANDARD_UNITS.has(standardUnit)) {
      const inputIsVolume = inputName === "milliliter" || inputName === "liter"
      const standardIsVolume = standardUnit === "milliliter" || standardUnit === "liter"
      if (inputIsVolume && !standardIsVolume) {
        const gramsPerInput = unit.standardQuantity * (standardUnit === "kilogram" ? 1000 : standardUnit === "gram" ? 1 : GRAMS_PER_UNIT.get(standardUnit)!)
        if (!Number.isFinite(gramsPerInput) || gramsPerInput < 0.2 || gramsPerInput > 3.5) return null
        return quantity * gramsPerInput
      }
      if (context && standardIsVolume) {
        const weight = knownGramsPerUnit(context, standardUnit) ?? (standardUnit === "milliliter" ? 1 : 1000)
        return quantity * unit.standardQuantity * weight
      }
      return unit.standardQuantity * GRAMS_PER_UNIT.get(standardUnit)! * quantity
    }
  }

  const name = resolveUnitName(unit)
  if (!name && context) {
    const piece = knownGramsPerUnit(context, /zehen?|cloves?/i.test(context.originalName) ? "clove" : "piece")
    if (piece !== null) return quantity * piece
  }
  if (name === "pinch") return quantity * config.units.pinchGrams
  if (context && (name === "milliliter" || name === "liter")) {
    const density = knownGramsPerUnit(context, name) ?? (name === "milliliter" ? 1 : 1000)
    const grams = quantity * density
    return Number.isFinite(grams) && grams <= quantity * (name === "milliliter" ? 3.5 : 3500) ? grams : null
  }
  if (context && name && ["teaspoon", "tablespoon", "milliliter", "liter", "cup", "piece", "clove"].includes(name)) {
    const known = knownGramsPerUnit(context, name)
    return known === null ? null : quantity * known
  }
  const gramsPerUnit = name === null ? null : GRAMS_PER_UNIT.get(name)
  return gramsPerUnit == null ? null : quantity * gramsPerUnit
}

export function isKnownUnitName(name: string): boolean {
  return GRAMS_PER_UNIT.has(normalizeUnitName(name))
}
