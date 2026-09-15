import type { MealieUnit } from "../types.js"
import { estimateSpoonCupGrams, estimatePieceWeightGrams, estimateVolumeGrams, type FoodIdentity } from "./food-density.js"

export interface GramConversion {
  grams: number
  /** true when a food-specific density/piece-weight table (or an LLM estimate) was used — not an exact structured/fixed mass conversion. */
  estimated: boolean
}

interface ConversionEntry {
  gramsPerUnit: number
}

/**
 * Units whose gram weight is fixed regardless of what food is being measured. Only true MASS
 * units belong here (g/kg/mg/oz/lb) — ml/l are volume units and are handled separately via
 * food-specific density, since their gram weight is not constant across foods.
 */
const FIXED_MASS_UNITS: Record<string, ConversionEntry> = {
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

/** Volume units — NOT fixed-gram. Resolved via food-specific density (see food-density.ts); never assume density = 1. */
const VOLUME_UNIT_NAMES = new Set(["ml", "milliliter", "milliliters", "l", "liter", "liters"])

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
 * 1. explicit structured Mealie conversion (unit.standardQuantity/standardUnit) — mass units
 *    resolve deterministically here; if the standard unit is a volume (ml/l), it still needs
 *    food-specific density, same as priority 3 below.
 * 2. deterministic mass-unit conversion (g/kg/mg/oz/lb/...)
 * 3. food-specific density (EL/TL/cup/ml/l — 1 EL/ml oil != 1 EL/ml flour; never assumed = 1)
 * 4. known piece/package weight (Stück/Dose/Glas/Bund/Zehe/...)
 * LLM estimation (priority 5) is the caller's responsibility when this returns null.
 */
export function convertToGrams(quantity: number, unit: MealieUnit | null, food?: string | FoodIdentity): GramConversion | null {
  if (unit?.standardQuantity != null && unit.standardUnit != null) {
    const standardUnit = unit.standardUnit.toLowerCase().trim()
    const totalStandardQty = unit.standardQuantity * quantity

    const mass = FIXED_MASS_UNITS[standardUnit]
    if (mass) return { grams: totalStandardQty * mass.gramsPerUnit, estimated: false }

    if (VOLUME_UNIT_NAMES.has(standardUnit) && food) {
      const grams = estimateVolumeGrams(totalStandardQty, standardUnit, food)
      if (grams !== null) return { grams, estimated: true }
    }
    // Falls through to the candidate-based resolution below (e.g. unit.name) if the standard
    // unit was a volume we couldn't resolve a density for, rather than guessing density = 1.
  }

  const candidates = [unit?.name, unit?.abbreviation].filter((s): s is string => s != null && s.length > 0)

  for (const candidate of candidates) {
    const name = candidate.toLowerCase().trim()

    const mass = FIXED_MASS_UNITS[name]
    if (mass) return { grams: quantity * mass.gramsPerUnit, estimated: false }

    if (VOLUME_UNIT_NAMES.has(name) && food) {
      const grams = estimateVolumeGrams(quantity, name, food)
      if (grams !== null) return { grams, estimated: true }
    }

    if (SPOON_CUP_UNIT_NAMES.has(name) && food) {
      const grams = estimateSpoonCupGrams(quantity, name, food)
      if (grams !== null) return { grams, estimated: true }
    }

    if (PIECE_PACKAGE_UNIT_NAMES.has(name) && food) {
      const grams = estimatePieceWeightGrams(quantity, name, food)
      if (grams !== null) return { grams, estimated: true }
    }
  }

  return null
}
