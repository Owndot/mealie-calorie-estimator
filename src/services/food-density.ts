/**
 * Deterministic, food-specific gram estimates for units whose weight depends on what's being
 * measured (spoons, cups, pieces, packages). Matched against the structured/canonical food name
 * only — never originalText. Keeps 1 EL oil and 1 EL flour resolving to different gram values,
 * per the skill's unit conversion rules. LLM estimation is the last resort, used only when a
 * category/keyword match isn't found here.
 */

type SpoonCupDensity = {
  /** grams per level tablespoon (EL/Esslöffel/tablespoon) */
  tablespoon: number
  /** grams per level teaspoon (TL/Teelöffel/teaspoon) */
  teaspoon: number
  /** grams per US cup */
  cup: number
  /** grams per pinch (Prise) */
  pinch: number
}

interface CategoryEntry {
  keywords: RegExp
  density: SpoonCupDensity
}

const CATEGORY_DENSITIES: CategoryEntry[] = [
  {
    keywords: /\b(öl|oel|olivenöl|olive oil|oil|butter|margarine|schmalz|fett)\b/i,
    density: { tablespoon: 13.6, teaspoon: 4.5, cup: 218, pinch: 0.5 },
  },
  {
    keywords: /\b(honig|honey|sirup|syrup|ahornsirup|agavendicksaft)\b/i,
    density: { tablespoon: 21, teaspoon: 7, cup: 340, pinch: 0.6 },
  },
  {
    keywords: /\b(mehl|flour|stärke|staerke|starch|puderzucker)\b/i,
    density: { tablespoon: 7.8, teaspoon: 2.6, cup: 120, pinch: 0.3 },
  },
  {
    keywords: /\b(zucker|sugar)\b/i,
    density: { tablespoon: 12.5, teaspoon: 4.2, cup: 200, pinch: 0.5 },
  },
  {
    keywords: /\b(salz|salt)\b/i,
    density: { tablespoon: 18, teaspoon: 6, cup: 292, pinch: 0.3 },
  },
  {
    keywords: /\b(reis|rice|grieß|griess|semolina|couscous|quinoa|linsen|lentils|haferflocken|oats)\b/i,
    density: { tablespoon: 12, teaspoon: 4, cup: 185, pinch: 0.3 },
  },
  {
    keywords: /\b(käse|kaese|cheese|parmesan)\b.*\b(gerieben|geraspelt|grated)\b|geriebene[rn]?\s*käse/i,
    density: { tablespoon: 5, teaspoon: 1.7, cup: 100, pinch: 0.3 },
  },
  {
    keywords: /\b(sahne|cream|milch|milk|joghurt|yogurt|wasser|water|saft|juice|brühe|bruehe|broth)\b/i,
    density: { tablespoon: 15, teaspoon: 5, cup: 240, pinch: 0.5 },
  },
  {
    keywords: /\b(kakao|cocoa|backpulver|baking powder|natron|baking soda|hefe|yeast)\b/i,
    density: { tablespoon: 8, teaspoon: 3, cup: 100, pinch: 0.3 },
  },
]

/** Fallback used when no category keyword matches; treated as a generic dry/solid ingredient. */
const DEFAULT_DENSITY: SpoonCupDensity = { tablespoon: 12, teaspoon: 4, cup: 150, pinch: 0.4 }

function matchDensity(foodName: string): SpoonCupDensity {
  for (const entry of CATEGORY_DENSITIES) {
    if (entry.keywords.test(foodName)) return entry.density
  }
  return DEFAULT_DENSITY
}

/** Returns the matched category's density, or null if nothing matched (no generic-solid fallback for volume). */
function matchDensityForVolume(foodName: string): SpoonCupDensity | null {
  for (const entry of CATEGORY_DENSITIES) {
    if (entry.keywords.test(foodName)) return entry.density
  }
  return null
}

const SPOON_CUP_UNIT_KEYS: Record<string, keyof SpoonCupDensity> = {
  el: "tablespoon",
  esslöffel: "tablespoon",
  essloeffel: "tablespoon",
  tablespoon: "tablespoon",
  tablespoons: "tablespoon",
  tbsp: "tablespoon",
  tl: "teaspoon",
  teelöffel: "teaspoon",
  teeloeffel: "teaspoon",
  teaspoon: "teaspoon",
  teaspoons: "teaspoon",
  tsp: "teaspoon",
  cup: "cup",
  cups: "cup",
  tasse: "cup",
  tassen: "cup",
  becher: "cup",
  prise: "pinch",
  pinch: "pinch",
  pinches: "pinch",
}

/**
 * Resolves grams for a food-dependent spoon/cup/pinch unit. Returns null when the unit name
 * isn't one of these (caller should fall through to piece/package weights or LLM estimation).
 */
export function estimateSpoonCupGrams(quantity: number, unitName: string, canonicalFoodName: string): number | null {
  const key = SPOON_CUP_UNIT_KEYS[unitName.toLowerCase().trim()]
  if (!key) return null
  const density = matchDensity(canonicalFoodName)
  return quantity * density[key]
}

const VOLUME_ML_UNIT_KEYS: Record<string, "ml" | "l"> = {
  ml: "ml",
  milliliter: "ml",
  milliliters: "ml",
  l: "l",
  liter: "l",
  liters: "l",
}

/** 1 US tablespoon ≈ 15 mL — used to derive grams-per-mL from the same category density table above. */
const ML_PER_TABLESPOON = 15

/**
 * Resolves grams for a volume unit (ml/l) using food-specific density. Unlike the spoon/cup/pinch
 * table above, this deliberately has NO generic fallback density: ml/l are true volume units and
 * their gram weight depends entirely on the food's density (200ml water ≈ 200g, 200ml olive oil
 * ≈ 184g) — silently assuming density = 1 (i.e. water) for an unrecognized liquid would be exactly
 * the kind of unit-scale mistake the skill warns against. Returns null when no category matches,
 * so the caller falls through to a bounded LLM density/gram estimate as the last resort.
 */
export function estimateVolumeGrams(quantity: number, unitName: string, canonicalFoodName: string): number | null {
  const key = VOLUME_ML_UNIT_KEYS[unitName.toLowerCase().trim()]
  if (!key) return null

  const density = matchDensityForVolume(canonicalFoodName)
  if (!density) return null

  const gramsPerMl = density.tablespoon / ML_PER_TABLESPOON
  const milliliters = key === "l" ? quantity * 1000 : quantity
  return milliliters * gramsPerMl
}

interface PieceWeightEntry {
  keywords: RegExp
  /** grams for one unit of the given unit name */
  unitWeights: Partial<Record<string, number>>
}

const PIECE_WEIGHTS: PieceWeightEntry[] = [
  {
    keywords: /\b(ei|eier|egg|eggs)\b/i,
    unitWeights: { stück: 53, stueck: 53, piece: 53, pieces: 53 },
  },
  {
    keywords: /\b(knoblauch|garlic)\b/i,
    unitWeights: { zehe: 5, zehen: 5, clove: 5, cloves: 5 },
  },
  {
    keywords: /\b(zwiebel|onion)\b/i,
    unitWeights: { stück: 110, stueck: 110, piece: 110, pieces: 110 },
  },
  {
    keywords: /\b(tomate|tomato)\b/i,
    unitWeights: { stück: 120, stueck: 120, piece: 120, pieces: 120, dose: 400, dosen: 400 },
  },
  {
    keywords: /\b(kartoffel|potato)\b/i,
    unitWeights: { stück: 150, stueck: 150, piece: 150, pieces: 150 },
  },
  {
    keywords: /\b(zitrone|lemon)\b/i,
    unitWeights: { stück: 58, stueck: 58, piece: 58, pieces: 58 },
  },
  {
    keywords: /\b(apfel|apple)\b/i,
    unitWeights: { stück: 182, stueck: 182, piece: 182, pieces: 182 },
  },
  {
    keywords: /\b(banane|banana)\b/i,
    unitWeights: { stück: 118, stueck: 118, piece: 118, pieces: 118 },
  },
  {
    keywords: /\b(lauch|leek)\b/i,
    unitWeights: { stange: 150, stangen: 150 },
  },
  {
    keywords: /\b(sellerie|celery)\b/i,
    unitWeights: { stange: 40, stangen: 40 },
  },
  {
    keywords: /\b(petersilie|parsley|basilikum|basil|koriander|cilantro|dill|schnittlauch|chives)\b/i,
    unitWeights: { bund: 30, bunde: 30, bündel: 30 },
  },
  {
    keywords: /\b(hefe|yeast)\b/i,
    unitWeights: { päckchen: 7, paeckchen: 7, packung: 7, packungen: 7, würfel: 42, wuerfel: 42 },
  },
]

/** Generic package/container weights used only when no food-specific piece weight matched above. */
const DEFAULT_UNIT_WEIGHTS: Partial<Record<string, number>> = {
  dose: 400,
  dosen: 400,
  glas: 340,
  gläser: 340,
  packung: 250,
  packungen: 250,
  päckchen: 15,
  paeckchen: 15,
  bund: 100,
  bunde: 100,
}

/**
 * Resolves grams for a piece/package unit (Stück, Dose, Glas, Bund, Zehe, Stange, Packung,
 * Päckchen). Returns null when there's no deterministic match, meaning the caller should fall
 * through to the LLM gram estimate as a last resort.
 */
export function estimatePieceWeightGrams(quantity: number, unitName: string, canonicalFoodName: string): number | null {
  const key = unitName.toLowerCase().trim()

  for (const entry of PIECE_WEIGHTS) {
    if (entry.keywords.test(canonicalFoodName)) {
      const weight = entry.unitWeights[key]
      if (weight != null) return quantity * weight
    }
  }

  const fallback = DEFAULT_UNIT_WEIGHTS[key]
  return fallback != null ? quantity * fallback : null
}
