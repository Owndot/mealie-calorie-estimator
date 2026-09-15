import { normalizeIdentityText } from "../utils/text-normalize.js"

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
  /**
   * Single-word keywords matched as EXACT normalized tokens, and multi-word keywords (containing a
   * space) matched as a contiguous phrase. Never as free substrings: "corn" must not match "acorn".
   */
  keywords: string[]
  /**
   * OPT-IN German compound heads. German compounds put the head noun LAST, so a token ENDING in one
   * of these is a member of the category: "Gemuesebruehe"/"Huehnerbruehe" end in "bruehe",
   * "Sonnenblumenoel" ends in "oel". This is why it is opt-in per category rather than a global
   * rule — a global "ends with" would match "acorn" for "corn" and "Blumenkohlbrei" for "ei".
   * Deliberately kept tiny; it is not a vocabulary list.
   *
   * Heads must never match a DIFFERENT food that merely starts with the word: "Wassermelone",
   * "Salzkartoffeln", "Milchreis", "Saftschorle", "Bruehwurst", "Oelsardinen" and "Weintrauben" all
   * fail head-matching precisely because the shared word is the modifier, not the head.
   */
  compoundHeads?: string[]
  /** Optional extra requirement: every group must contribute at least one matching token. */
  requiresAll?: string[][]
  density: SpoonCupDensity
}

const CATEGORY_DENSITIES: CategoryEntry[] = [
  {
    keywords: ["oel", "oil", "butter", "margarine", "schmalz", "fett"],
    compoundHeads: ["oel"],
    density: { tablespoon: 13.6, teaspoon: 4.5, cup: 218, pinch: 0.5 },
  },
  {
    keywords: ["honig", "honey", "sirup", "syrup", "ahornsirup", "agavendicksaft"],
    compoundHeads: ["sirup", "honig"],
    density: { tablespoon: 21, teaspoon: 7, cup: 340, pinch: 0.6 },
  },
  {
    keywords: ["mehl", "flour", "staerke", "starch", "puderzucker"],
    compoundHeads: ["mehl"],
    density: { tablespoon: 7.8, teaspoon: 2.6, cup: 120, pinch: 0.3 },
  },
  {
    keywords: ["zucker", "sugar"],
    compoundHeads: ["zucker"],
    density: { tablespoon: 12.5, teaspoon: 4.2, cup: 200, pinch: 0.5 },
  },
  {
    keywords: ["salz", "salt"],
    compoundHeads: ["salz"],
    density: { tablespoon: 18, teaspoon: 6, cup: 292, pinch: 0.3 },
  },
  {
    keywords: ["reis", "rice", "griess", "semolina", "couscous", "quinoa", "linsen", "lentils", "haferflocken", "oats"],
    // No heads: "Milchreis" is a milk-rice pudding, not the grain, so "reis" must not be a head.
    density: { tablespoon: 12, teaspoon: 4, cup: 185, pinch: 0.3 },
  },
  {
    // Grated cheese only — plain cheese has a completely different bulk density, so BOTH a cheese
    // word and a grated word must be present.
    keywords: [],
    requiresAll: [["kaese", "cheese", "parmesan"], ["gerieben", "geriebener", "geriebenen", "geraspelt", "grated"]],
    density: { tablespoon: 5, teaspoon: 1.7, cup: 100, pinch: 0.3 },
  },
  {
    // Water-based liquids, all ~1 g/ml. "wein"/"wine" added from live evidence: Rotwein missed this
    // table entirely and fell through to an LLM density estimate that came back 0.85 g/ml — inside
    // the catastrophic guard but materially wrong for a water-based beverage (~0.99).
    keywords: ["sahne", "cream", "milch", "milk", "joghurt", "yogurt", "wasser", "water", "saft", "juice", "bruehe", "broth", "wein", "wine"],
    compoundHeads: ["bruehe", "milch", "sahne", "saft", "wasser", "wein"],
    density: { tablespoon: 15, teaspoon: 5, cup: 240, pinch: 0.5 },
  },
  {
    keywords: ["kakao", "cocoa", "backpulver", "baking powder", "natron", "baking soda", "hefe", "yeast"],
    density: { tablespoon: 8, teaspoon: 3, cup: 100, pinch: 0.3 },
  },
]

/** Fallback used when no category keyword matches; treated as a generic dry/solid ingredient. */
const DEFAULT_DENSITY: SpoonCupDensity = { tablespoon: 12, teaspoon: 4, cup: 150, pinch: 0.4 }

/**
 * The same identity fields the provider matcher already works from, so density recognition and
 * food matching agree on what an ingredient IS. Tried in order of reliability: the LLM's
 * modifier-stripped core noun first, then the cleaned canonical names, then the raw structured
 * Mealie name — which is the only one guaranteed to exist when classification degraded.
 */
export interface FoodIdentity {
  coreFoodGerman?: string | null
  coreFoodEnglish?: string | null
  canonicalGerman?: string | null
  canonicalEnglish?: string | null
  structuredName?: string | null
}

/** Accepts a bare name so callers that only have one string keep working. */
export function toFoodIdentity(food: string | FoodIdentity): FoodIdentity {
  return typeof food === "string" ? { structuredName: food } : food
}

function identityTexts(identity: FoodIdentity): string[] {
  return [
    identity.coreFoodGerman, identity.coreFoodEnglish,
    identity.canonicalGerman, identity.canonicalEnglish,
    identity.structuredName,
  ].filter((s): s is string => typeof s === "string" && s.trim().length > 0)
}

function matchesCategory(tokens: string[], normalized: string, entry: CategoryEntry): boolean {
  if (entry.requiresAll) {
    return entry.requiresAll.every((group) => group.some((k) => tokens.includes(k)))
  }
  for (const keyword of entry.keywords) {
    if (keyword.includes(" ")) {
      if (normalized.includes(keyword)) return true
    } else if (tokens.includes(keyword)) {
      return true
    }
  }
  return entry.compoundHeads?.some((head) => tokens.some((t) => t !== head && t.endsWith(head))) ?? false
}

function matchCategory(identity: FoodIdentity): SpoonCupDensity | null {
  for (const text of identityTexts(identity)) {
    const normalized = normalizeIdentityText(text)
    const tokens = normalized.split(" ").filter(Boolean)
    for (const entry of CATEGORY_DENSITIES) {
      if (matchesCategory(tokens, normalized, entry)) return entry.density
    }
  }
  return null
}

function matchDensity(food: string | FoodIdentity): SpoonCupDensity {
  return matchCategory(toFoodIdentity(food)) ?? DEFAULT_DENSITY
}

/** Returns the matched category's density, or null if nothing matched (no generic-solid fallback for volume). */
function matchDensityForVolume(food: string | FoodIdentity): SpoonCupDensity | null {
  return matchCategory(toFoodIdentity(food))
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
export function estimateSpoonCupGrams(quantity: number, unitName: string, food: string | FoodIdentity): number | null {
  const key = SPOON_CUP_UNIT_KEYS[unitName.toLowerCase().trim()]
  if (!key) return null
  const density = matchDensity(food)
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
export function estimateVolumeGrams(quantity: number, unitName: string, food: string | FoodIdentity): number | null {
  const key = VOLUME_ML_UNIT_KEYS[unitName.toLowerCase().trim()]
  if (!key) return null

  const density = matchDensityForVolume(food)
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
export function estimatePieceWeightGrams(quantity: number, unitName: string, food: string | FoodIdentity): number | null {
  const key = unitName.toLowerCase().trim()
  const texts = identityTexts(toFoodIdentity(food))

  for (const entry of PIECE_WEIGHTS) {
    if (texts.some((t) => entry.keywords.test(t))) {
      const weight = entry.unitWeights[key]
      if (weight != null) return quantity * weight
    }
  }

  const fallback = DEFAULT_UNIT_WEIGHTS[key]
  return fallback != null ? quantity * fallback : null
}
