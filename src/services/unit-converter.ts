import type { MealieUnit } from "../types.js"
import { estimateSpoonCupGrams, estimatePieceWeightGrams } from "./food-density.js"

export interface GramConversion {
  grams: number
  /** true when a food-specific density/piece-weight table was used (not an exact structured/fixed conversion). */
  estimated: boolean
}

interface ConversionEntry {
  gramsPerUnit: number
}

/** Units whose gram weight is fixed regardless of what food is being measured. */
const FIXED_UNITS: Record<string, ConversionEntry> = {
  gram: { gramsPerUnit: 1 },
  grams: { gramsPerUnit: 1 },
  gramm: { gramsPerUnit: 1 },
  gramms: { gramsPerUnit: 1 },
  g: { gramsPerUnit: 1 },
  kilogram: { gramsPerUnit: 1000 },
  kilograms: { gramsPerUnit: 1000 },
  kilogramm: { gramsPerUnit: 1000 },
  kg: { gramsPerUnit: 1000 },
  milligram: { gramsPerUnit: 0.001 },
  milligrams: { gramsPerUnit: 0.001 },
  mg: { gramsPerUnit: 0.001 },
  ounce: { gramsPerUnit: 28.35 },
  ounces: { gramsPerUnit: 28.35 },
  oz: { gramsPerUnit: 28.35 },
  pound: { gramsPerUnit: 453.592 },
  pounds: { gramsPerUnit: 453.592 },
  lb: { gramsPerUnit: 453.592 },
  lbs: { gramsPerUnit: 453.592 },
  dash: { gramsPerUnit: 0.3 },
  dashes: { gramsPerUnit: 0.3 },
}

/** Liquid volume units, assumed water-density (1ml = 1g) unless a food-specific density applies. */
const LIQUID_VOLUME_UNITS: Record<string, ConversionEntry> = {
  ml: { gramsPerUnit: 1 },
  milliliter: { gramsPerUnit: 1 },
  milliliters: { gramsPerUnit: 1 },
  l: { gramsPerUnit: 1000 },
  liter: { gramsPerUnit: 1000 },
  liters: { gramsPerUnit: 1000 },
}

/** Units that depend on the food being measured — resolved via the density module, never a single global constant. */
const SPOON_CUP_UNIT_NAMES = new Set([
  "el", "esslöffel", "essloeffel", "tablespoon", "tablespoons", "tbsp",
  "tl", "teelöffel", "teeloeffel", "teaspoon", "teaspoons", "tsp",
  "cup", "cups", "tasse", "tassen", "becher",
  "prise", "pinch", "pinches",
])

const PIECE_PACKAGE_UNIT_NAMES = new Set([
  "stück", "stueck", "piece", "pieces", "slice", "slices",
  "dose", "dosen", "glas", "gläser", "glaeser",
  "bund", "bunde", "bündel", "buendel",
  "packung", "packungen", "päckchen", "paeckchen",
  "stange", "stangen", "zehe", "zehen", "clove", "cloves",
])

/**
 * Resolves an ingredient quantity+unit to grams. Conversion priority (per the skill):
 * 1. explicit structured Mealie conversion (unit.standardQuantity/standardUnit)
 * 2. deterministic unit conversion (g/kg/ml/l/oz/lb/...)
 * 3. food-specific density (EL/TL/cup — 1 EL oil != 1 EL flour)
 * 4. known piece/package weight (Stück/Dose/Glas/Bund/Zehe/...)
 * LLM estimation (priority 5) is the caller's responsibility when this returns null.
 */
export function convertToGrams(quantity: number, unit: MealieUnit | null, canonicalFoodName?: string): GramConversion | null {
  if (unit?.standardQuantity != null && unit.standardUnit != null) {
    const grams = standardUnitToGrams(unit.standardQuantity, unit.standardUnit)
    if (grams !== null) return { grams: grams * quantity, estimated: false }
  }

  const candidates = [unit?.name, unit?.abbreviation].filter((s): s is string => s != null && s.length > 0)

  for (const candidate of candidates) {
    const name = candidate.toLowerCase().trim()

    const fixed = FIXED_UNITS[name]
    if (fixed) return { grams: quantity * fixed.gramsPerUnit, estimated: false }

    const liquid = LIQUID_VOLUME_UNITS[name]
    if (liquid) return { grams: quantity * liquid.gramsPerUnit, estimated: false }

    if (SPOON_CUP_UNIT_NAMES.has(name) && canonicalFoodName) {
      const grams = estimateSpoonCupGrams(quantity, name, canonicalFoodName)
      if (grams !== null) return { grams, estimated: true }
    }

    if (PIECE_PACKAGE_UNIT_NAMES.has(name) && canonicalFoodName) {
      const grams = estimatePieceWeightGrams(quantity, name, canonicalFoodName)
      if (grams !== null) return { grams, estimated: true }
    }
  }

  return null
}

function standardUnitToGrams(quantity: number, unit: string): number | null {
  const u = unit.toLowerCase().trim()
  if (u === "g" || u === "gram" || u === "grams") return quantity
  if (u === "kg" || u === "kilogram" || u === "kilograms") return quantity * 1000
  if (u === "mg" || u === "milligram" || u === "milligrams") return quantity * 0.001
  if (u === "ml" || u === "milliliter" || u === "milliliters") return quantity
  if (u === "l" || u === "liter" || u === "liters") return quantity * 1000
  if (u === "oz" || u === "ounce" || u === "ounces") return quantity * 28.35
  if (u === "lb" || u === "lbs" || u === "pound" || u === "pounds") return quantity * 453.592
  return null
}
