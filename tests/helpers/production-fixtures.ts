import type { ClassificationStub } from "./e2e-pipeline.js"
import type { MealieRecipe } from "../../src/types.js"

/**
 * The four acceptance recipes, transcribed from the LIVE Mealie instance: every ingredient, its
 * real quantity and unit, and the canonicalEnglish the production classifier actually produced
 * (read back from `calorie_estimator_provenance`).
 *
 * This file exists because an earlier version of these fixtures carried a SUBSET of each recipe —
 * 7 of the Big-Mac-Salat's 16 ingredients, 5 of Butter Chicken's 15 — which made their totals
 * silently incomparable with production's. A before/after quoted across that gap looked like a
 * much larger improvement than the change actually produced. Fixture fidelity is the whole point
 * of these tests, so the ingredient lists here are exhaustive and the grams are production's own.
 *
 * Two things here are modelled rather than transcribed, because provenance does not record them:
 * the German/core/attribute classifier fields, and the per-100 g values the LLM returned for
 * ingredients no database could answer. The modelled LLM values are chosen to reconcile with the
 * recorded whole-recipe total; they are not claims about what the model actually said.
 *
 * `tests/production-recipes-e2e.test.ts` verifies the modelling by asserting that each fixture
 * reproduces production's per-ingredient provider AND record.
 */

export interface ProductionRecipe {
  slug: string
  servings: number
  /** Mealie's own mass yield, where the recipe states one. */
  yieldQuantity?: number
  yieldUnit?: string
  /** [quantity, unit, foodName] exactly as Mealie holds them. */
  ingredients: [number, string | null, string][]
  classifications: ClassificationStub[]
  /** Gram estimates the LLM supplied in production, keyed by the English text in the prompt. */
  llmGrams: Record<string, number>
  /** Per-100 g nutrient estimates the LLM supplied, keyed by the English food name. */
  llmNutrients: Record<string, Record<string, number>>
  /** The whole-recipe total production actually recorded. */
  productionTotalKcal: number
  /**
   * What production recorded per ingredient: [name, provider, record, grams, confidence].
   * Transcribed verbatim from `calorie_estimator_provenance`. This is what makes the fixture's
   * total comparable with production's — a matching total over different records would be a
   * coincidence, not fidelity.
   */
  productionRows: [string, string, string | null, number, number][]
  /**
   * Rows the replay CANNOT reproduce, each with what it produces instead and why. Every field left
   * out still has to match production exactly — a deviation narrows one cell, it does not excuse
   * the row. Listed rather than papered over: a fixture that quietly relaxes an assertion to stay
   * green is worth less than no fixture, because it still reads as proof.
   */
  fixtureDeviations?: Record<string, { provider?: string; record?: string | null; confidence?: number; why: string }>
  /**
   * How far the replay's total may sit from `productionTotalKcal`, in kcal.
   *
   * Every database row reconciles to the milli-kcal, because its record and grams are transcribed
   * and its per-100 g comes from the same database production read. The slack is entirely the
   * per-100 g values the LLM returned for rows no database answered: provenance does not store
   * them, so they are modelled. Where a plausible round number closes the gap exactly it is used;
   * where closing it would need a value like 150.312 the residual is left and pinned HERE, because
   * false precision dressed as fidelity is worse than a declared gap.
   */
  reconcilesWithin: number
}

/**
 * The reranker's RECORDED verdicts, read back from `calorie_estimator_provenance` on the live
 * recipes. Each entry is one decision the production judge actually made, with its own reason text.
 *
 * This exists because a stub with a fixed verdict does not model production, in either direction.
 * An always-accept stub put "rote Chilischoten" on BLS's sweet-pepper record, which production never
 * did. An always-decline stub then lost Ketchup, Pfeffer and Wasser, which production DID resolve —
 * and dropping three ingredients silently moves the total, which is the exact failure mode these
 * fixtures exist to prevent. Replaying the recorded verdicts is the only version that reproduces
 * production's per-ingredient records, so it is the only one whose totals can be compared to
 * production's.
 *
 * Four of the five are transcribed verbatim (provenance stores `productName`, `providerId` and
 * `rerankReason` for every `llmReranked` match). The fifth, `red chili peppers`, is INFERRED: its
 * USDA match came back `fuzzy`/not-reranked, and the only way for USDA's `partial-core` trigger to
 * fire and still leave the deterministic order standing is a verdict naming the candidate that
 * already ranked first — a decline would have rejected the match outright, as it does here. Its
 * reason text is therefore descriptive, not a transcript.
 */
export const PRODUCTION_RERANK_DECISIONS: { food: string; record: string; reason: string }[] = [
  { food: "pepper", record: "Pfeffer schwarz, getrocknet", reason: "Pfeffer schwarz, getrocknet is dried pepper." },
  { food: "water", record: "Trinkwasser", reason: "Trinkwasser is plain water, matching the ingredient." },
  { food: "light mayo", record: "Salatmayonnaise (Fertigprodukt)", reason: "Salatmayonnaise is a type of light mayo." },
  { food: "ketchup", record: "Tomatenketchup", reason: "Tomatenketchup is the same food as ketchup." },
  { food: "red chili peppers", record: "Peppers, hot chili, red, raw", reason: "the deterministic top candidate stood" },
]

/**
 * Replays {@link PRODUCTION_RERANK_DECISIONS} against a rerank prompt: the recorded record wins if
 * it is among the offered candidates, and every food production did not rerank — or did rerank and
 * declined — answers NONE, which is what the real judge returned for them.
 */
export function replayProductionRerank(candidates: string[], prompt: string): string {
  const english = /\benglish: (.+)/.exec(prompt)?.[1]?.trim().toLowerCase() ?? ""
  for (const decision of PRODUCTION_RERANK_DECISIONS) {
    if (decision.food !== english) continue
    const index = candidates.findIndex((line) => line.includes(decision.record))
    if (index === -1) continue
    return JSON.stringify({ selected: index + 1, confidence: 0.9, reason: decision.reason })
  }
  return JSON.stringify({ selected: null, confidence: 0.9, reason: "no candidate is the same food" })
}

const c = (
  index: number, de: string, en: string, coreDe: string, coreEn: string,
  over: Partial<ClassificationStub> = {},
): ClassificationStub => ({ index, canonicalGerman: de, canonicalEnglish: en, coreFoodGerman: coreDe, coreFoodEnglish: coreEn, ...over })

export const KIDNEY_CURRY: ProductionRecipe = {
  slug: "einfaches-kidney-bohnen-tomaten-curry",
  servings: 2,
  productionTotalKcal: 1679.514,
  ingredients: [
    [2, "Stück", "Knoblauchzehen"], [5, "Gramm", "Ingwer"], [0.5, "Stück", "Limette"],
    [5, "Gramm", "Koriander"], [200, "Gramm", "Tomate"], [1, "Stück", "Zwiebel"],
    [100, "Gramm", "Basmati-Reis"], [200, "Milliliter", "Kokosmilch"],
    [400, "Gramm", "Kidneybohnen a. d. Dose"], [2, "Esslöffel", "Olivenöl"],
    [1, "Prise", "Salz"], [1, "Prise", "Pfeffer"], [2, "Teelöffel", "Curry"],
  ],
  classifications: [
    c(0, "Knoblauchzehen", "garlic cloves", "Knoblauch", "garlic", { state: "raw", category: "vegetable" }),
    c(1, "Ingwer", "ginger", "Ingwer", "ginger", { state: "raw", category: "spice" }),
    c(2, "Limette", "lime", "Limette", "lime", { state: "raw", category: "fruit" }),
    c(3, "Koriander", "coriander", "Koriander", "coriander", { category: "herb" }),
    c(4, "Tomate", "tomato", "Tomate", "tomato", { state: "raw", category: "vegetable" }),
    c(5, "Zwiebel", "onion", "Zwiebel", "onion", { state: "raw", category: "vegetable" }),
    c(6, "Basmati-Reis", "Basmati rice", "Reis", "rice", { state: "raw", category: "grain" }),
    c(7, "Kokosmilch", "coconut milk", "Kokosmilch", "coconut milk", { category: "dairy", foodType: "processed_single_food" }),
    c(8, "Kidneybohnen aus der Dose", "canned kidney beans", "Kidneybohnen", "kidney beans",
      { preservation: "canned", category: "legume", foodType: "processed_single_food" }),
    c(9, "Olivenöl", "olive oil", "Olivenöl", "olive oil", { category: "oil" }),
    c(10, "Salz", "salt", "Salz", "salt", { category: "seasoning" }),
    c(11, "Pfeffer", "pepper", "Pfeffer", "pepper", { category: "spice" }),
    c(12, "Curry", "curry", "Curry", "curry", { category: "spice" }),
  ],
  llmGrams: { "garlic cloves": 3, lime: 100, onion: 110, "olive oil": 13.6, salt: 0.3, pepper: 0.4, curry: 4 },
  llmNutrients: {
    coriander: { kcal: 23, protein: 2, carbs: 4, fat: 0.5 },
    curry: { kcal: 150, protein: 13, carbs: 26, fat: 5 },
  },
  // 1666.364 from the database rows + 13.150 from these two = 1679.514, production's own total.
  reconcilesWithin: 0.001,
  productionRows: [
    ["Knoblauchzehen", "bls", "Knoblauch roh", 6, 0.85],
    ["Ingwer", "bls", "Ingwer/Ingwerwurzel, roh", 5, 0.85],
    ["Limette", "bls", "Limette roh", 50, 0.85],
    ["Koriander", "llm-nutrient", null, 5, 0.35],
    ["Tomate", "bls", "Tomate roh", 200, 0.85],
    ["Zwiebel", "bls", "Speisezwiebel roh", 110, 0.75],
    ["Basmati-Reis", "bls", "Reis poliert, roh", 100, 0.85],
    ["Kokosmilch", "bls", "Kokosmilch/Kokosnussmilch", 200, 0.85],
    ["Kidneybohnen a. d. Dose", "bls", "Kidneybohne reif, Konserve, abgetropft", 400, 0.85],
    ["Olivenöl", "bls", "Olivenöl", 27.2, 0.92],
    ["Salz", "bls", "Speisesalz/Siedesalz/Tafelsalz", 0.3, 0.75],
    ["Pfeffer", "bls", "Pfeffer schwarz, getrocknet", 0.4, 0.8],
    ["Curry", "llm-nutrient", null, 8, 0.35],
  ],
}

export const TIKKA_PASTE: ProductionRecipe = {
  slug: "tikka-paste",
  servings: 1,
  yieldQuantity: 800,
  yieldUnit: "g",
  productionTotalKcal: 2872.68,
  ingredients: [
    [40, "Gramm", "Korianderkörner"], [40, "Gramm", "Kreuzkümmelsamen"], [5, "Stück", "rote Chilischoten"],
    [1, "Teelöffel", "rosa Pfefferkorn"], [50, "Gramm", "Koriander"], [100, "Gramm", "Knoblauchzehen"],
    [100, "Gramm", "Ingwer"], [220, "Gramm", "Pflanzenöl"], [100, "Gramm", "Wasser"],
    [100, "Gramm", "Zitronensaft"], [30, "Gramm", "Salz"], [50, "Gramm", "Röstzwiebel"],
    [140, "Gramm", "Tomatenmark"], [1, "Teelöffel", "Kurkuma"], [1, "Teelöffel", "Chilipulver"],
    [1, "Teelöffel", "Garam Masala"],
  ],
  classifications: [
    c(0, "Korianderkörner", "coriander seeds", "Koriandersamen", "coriander seeds", { form: "seed", category: "spice" }),
    c(1, "Kreuzkümmelsamen", "cumin seeds", "Kreuzkümmelsamen", "cumin seeds", { form: "seed", category: "spice" }),
    c(2, "rote Chilischoten", "red chili peppers", "Chilischote", "chili pepper", { state: "raw", category: "vegetable" }),
    c(3, "rosa Pfefferkorn", "pink peppercorns", "Pfefferkorn", "peppercorn", { category: "spice" }),
    c(4, "Koriander", "coriander", "Koriander", "coriander", { category: "herb" }),
    c(5, "Knoblauchzehen", "garlic cloves", "Knoblauch", "garlic", { state: "raw", category: "vegetable" }),
    c(6, "Ingwer", "ginger", "Ingwer", "ginger", { state: "raw", category: "spice" }),
    c(7, "Pflanzenöl", "plant oil", "Öl", "oil", { category: "oil" }),
    c(8, "Wasser", "water", "Wasser", "water", { category: "liquid" }),
    c(9, "Zitronensaft", "lemon juice", "Zitronensaft", "lemon juice", { category: "liquid" }),
    c(10, "Salz", "salt", "Salz", "salt", { category: "seasoning" }),
    c(11, "Röstzwiebeln", "fried onions", "Zwiebel", "onion", { state: "cooked", category: "vegetable" }),
    c(12, "Tomatenmark", "tomato paste", "Tomatenmark", "tomato paste", { form: "paste", category: "vegetable", foodType: "processed_single_food" }),
    c(13, "Kurkuma", "turmeric", "Kurkuma", "turmeric", { form: "ground", category: "spice" }),
    c(14, "Chilipulver", "chili powder", "Chili", "chili", { form: "powder", category: "spice" }),
    c(15, "Garam Masala", "garam masala", "Garam Masala", "garam masala", { category: "spice" }),
  ],
  llmGrams: { "red chili peppers": 10, "pink peppercorns": 4, turmeric: 4, "chili powder": 4, "garam masala": 4 },
  llmNutrients: {
    "pink peppercorns": { kcal: 251, protein: 10, carbs: 64, fat: 3 },
    coriander: { kcal: 23, protein: 2, carbs: 4, fat: 0.5 },
    "plant oil": { kcal: 884, protein: 0, carbs: 0, fat: 100 },
    "chili powder": { kcal: 282, protein: 13, carbs: 50, fat: 14 },
    "garam masala": { kcal: 379, protein: 14, carbs: 45, fat: 15 },
  },
  // 877.580 from the database rows + 1992.780 from these five = 2870.360 against production's
  // 2872.680. The 2.32 kcal gap is 0.08% and sits entirely in the five modelled per-100 g values;
  // closing it exactly would mean nudging one of them off its plausible round figure (plant oil
  // 884 -> 885.05, or garam masala 379 -> 437) to hit a total, which is fitting, not fidelity.
  reconcilesWithin: 2.4,
  productionRows: [
    ["Korianderkörner", "usda", "Spices, coriander seed", 40, 0.7],
    ["Kreuzkümmelsamen", "usda", "Spices, cumin seed", 40, 0.7],
    ["rote Chilischoten", "usda", "Peppers, hot chili, red, raw", 50, 0.7],
    ["rosa Pfefferkorn", "llm-nutrient", null, 4, 0.35],
    ["Koriander", "llm-nutrient", null, 50, 0.35],
    ["Knoblauchzehen", "bls", "Knoblauch roh", 100, 0.85],
    ["Ingwer", "bls", "Ingwer/Ingwerwurzel, roh", 100, 0.85],
    ["Pflanzenöl", "llm-nutrient", null, 220, 0.35],
    ["Wasser", "bls", "Trinkwasser", 100, 0.8],
    ["Zitronensaft", "bls", "Zitronensaft", 100, 0.92],
    ["Salz", "bls", "Speisesalz/Siedesalz/Tafelsalz", 30, 0.75],
    ["Röstzwiebel", "bls", "Röstzwiebeln (Fertigprodukt)", 50, 0.85],
    ["Tomatenmark", "bls", "Tomatenmark", 140, 0.92],
    ["Kurkuma", "usda", "Spices, turmeric, ground", 4, 0.8],
    ["Chilipulver", "llm-nutrient", null, 4, 0.35],
    ["Garam Masala", "llm-nutrient", null, 4, 0.35],
  ],
  fixtureDeviations: {
    // Same RECORD as production ("Peppers, hot chili, red, raw"), reached differently. Production
    // accepted it deterministically (matchReason "fuzzy", confidence 0.7). Against the USDA page
    // recorded here, the deterministic ranker puts "Peppers, sweet, red, raw" FIRST (score 62) and
    // the hot chilli third (39) — a query whose core is "chili pepper" outscored by a record that
    // does not contain the word — so USDA's `partial-core` trigger fires and the judge moves it,
    // giving confidence 0.8 and matchReason "llm-reranked".
    //
    // Verified identical on main (867d85f): NOT caused by this PR. Two things feed it — USDA's
    // live result set has drifted since production's run, and the core gate accepts a multi-word
    // core on any ONE of its tokens, so the generic head noun "pepper" carries the identity on its
    // own. The second is a real ranking weakness and is reported as such; fixing it is a matcher
    // change, which this PR deliberately is not. Today the reranker is what stands between this
    // query and sweet bell pepper.
    "rote Chilischoten": {
      confidence: 0.8,
      why: "USDA result drift + a multi-word core satisfied by its generic head noun; the reranker corrects it",
    },
  },
}

export const BUTTER_CHICKEN: ProductionRecipe = {
  slug: "butter-chicken",
  servings: 4,
  productionTotalKcal: 2215.155,
  ingredients: [
    [500, "Gramm", "Hähnchenbrust"], [100, "Gramm", "Tikka-Paste"], [40, "Gramm", "Ghee"],
    [150, "Gramm", "Zwiebel"], [20, "Gramm", "Ingwer frisch"], [10, "Gramm", "Koriander"],
    [3, "Zehe", "Knoblauch"], [2, "Stück", "grüne Chilischoten"], [1, "Teelöffel", "Salz"],
    [2, "Teelöffel", "Kreuzkümmel gemahlen"], [2, "Teelöffel", "Getrockneter Koriander"],
    [0.5, "Teelöffel", "Kurkuma"], [100, "Gramm", "Wasser"], [70, "Gramm", "Tomatenmark"],
    [500, "Gramm", "Kochsahne 15%"],
  ],
  classifications: [
    c(0, "Hähnchenbrust", "chicken breast", "Hähnchenbrust", "chicken breast", { state: "raw", category: "meat" }),
    c(1, "Tikka-Paste", "tikka paste", "Tikka-Paste", "tikka paste", { category: "seasoning", foodType: "processed_single_food" }),
    c(2, "Ghee", "ghee", "Ghee", "ghee", { category: "fat" }),
    c(3, "Zwiebel", "onion", "Zwiebel", "onion", { state: "raw", category: "vegetable" }),
    c(4, "Ingwer, frisch", "fresh ginger", "Ingwer", "ginger", { state: "raw", preservation: "fresh", category: "spice" }),
    c(5, "Koriander", "coriander", "Koriander", "coriander", { category: "herb" }),
    c(6, "Knoblauch", "garlic", "Knoblauch", "garlic", { state: "raw", category: "vegetable" }),
    c(7, "grüne Chilischoten", "green chilies", "Chilischote", "chili pepper", { state: "raw", category: "vegetable" }),
    c(8, "Salz", "salt", "Salz", "salt", { category: "seasoning" }),
    c(9, "Kreuzkümmel, gemahlen", "ground cumin", "Kreuzkümmel", "cumin", { form: "ground", state: "dried", category: "spice" }),
    c(10, "Koriander, getrocknet", "dried coriander", "Koriander", "coriander", { preservation: "dried", category: "herb" }),
    c(11, "Kurkuma", "turmeric", "Kurkuma", "turmeric", { form: "ground", category: "spice" }),
    c(12, "Wasser", "water", "Wasser", "water", { category: "liquid" }),
    c(13, "Tomatenmark", "tomato paste", "Tomatenmark", "tomato paste", { form: "paste", category: "vegetable", foodType: "processed_single_food" }),
    // The explicit percentage that must survive the whole pipeline.
    c(14, "Kochsahne 15 % Fett", "cooking cream 15%", "Sahne", "cream", { fatPercent: 15, category: "dairy", foodType: "processed_single_food" }),
  ],
  llmGrams: { garlic: 5, "green chilies": 10, salt: 6, "ground cumin": 4, "dried coriander": 4, turmeric: 4 },
  llmNutrients: {
    coriander: { kcal: 23, protein: 2, carbs: 4, fat: 0.5 },
    "green chilies": { kcal: 40, protein: 2, carbs: 9, fat: 0.2 },
    "dried coriander": { kcal: 279, protein: 21, carbs: 52, fat: 4.8 },
    "cooking cream 15%": { kcal: 150, protein: 3, carbs: 4, fat: 15 },
  },
  // 1430.975 from the database + recipe rows + 782.620 from these four = 2213.595 against
  // production's 2215.155. Same 0.07% residual, same reason: the cream would have to be 150.312
  // rather than 150 to close it.
  reconcilesWithin: 1.6,
  productionRows: [
    ["Hähnchenbrust", "bls", "Hähnchen Brustfilet, roh", 500, 0.75],
    ["Tikka-Paste", "mealie-recipe", "Tikka-Paste", 100, 0.85],
    ["Ghee", "bls", "Butterschmalz", 40, 0.92],
    ["Zwiebel", "bls", "Speisezwiebel roh", 150, 0.75],
    ["Ingwer frisch", "bls", "Ingwer/Ingwerwurzel, roh", 20, 0.85],
    ["Koriander", "llm-nutrient", null, 10, 0.35],
    ["Knoblauch", "bls", "Knoblauch roh", 15, 0.85],
    ["grüne Chilischoten", "llm-nutrient", null, 20, 0.35],
    ["Salz", "bls", "Speisesalz/Siedesalz/Tafelsalz", 6, 0.75],
    ["Kreuzkümmel gemahlen", "usda", "Spices, cumin seed", 8, 0.7],
    ["Getrockneter Koriander", "llm-nutrient", null, 8, 0.35],
    ["Kurkuma", "usda", "Spices, turmeric, ground", 2, 0.8],
    ["Wasser", "bls", "Trinkwasser", 100, 0.8],
    ["Tomatenmark", "bls", "Tomatenmark", 70, 0.92],
    ["Kochsahne 15%", "llm-nutrient", null, 500, 0.35],
  ],
}

/**
 * What the DEPLOYED PR #8 build (main 8a44799) actually produced for the Big-Mac-Salat, read back
 * from the live run — the regression this branch fixes.
 *
 * Two ingredients whose BLS record carried unmetAttributes ["reduced-fat"] were displaced by the
 * LLM estimate at the end of the chain, and the resolver logged that the estimate "satisfies the
 * stated nutritional attribute". It had no evidence for that: an estimate has no record name, so
 * the name-based attribute check never ran, and `unmetAttributes: []` meant "never asked", not
 * "nothing wrong". The beef estimate was 250 kcal/100 g — MORE than the 224 kcal ordinary mince it
 * replaced for being insufficiently lean.
 *
 *   mageres Rinderhackfleisch  400 g   BLS 224 -> llm-nutrient 250   +104.0 kcal
 *   Mayo Light                  12 g   BLS 490 -> llm-nutrient  50    -52.8 kcal
 *                                                                     -------
 *                                                              net   + 51.2 kcal
 *
 * 2553.416 + 51.2 = 2604.616 over 3 servings = 868. `tests/production-recipes-e2e.test.ts` drives
 * this exact input and reproduces 2604.616 on 8a44799; with the evidence check it returns to the
 * database records and production's own 2553.416.
 */
export const BIG_MAC_DEPLOYED_PR8 = {
  totalKcal: 2604.616,
  perServingKcal: 868,
  displaced: [
    { name: "mageres Rinderhackfleisch", grams: 400, wasKcalPer100g: 224, becameKcalPer100g: 250 },
    { name: "Mayo Light", grams: 12, wasKcalPer100g: 490, becameKcalPer100g: 50 },
  ],
} as const

export const BIG_MAC_SALAT: ProductionRecipe = {
  slug: "knuspriger-big-mac-salat",
  servings: 3,
  productionTotalKcal: 2553.416,
  ingredients: [
    [300, "g", "Nudeln"], [50, "g", "Parmesan"], [200, "g", "Eisbergsalat"],
    [400, "g", "mageres Rinderhackfleisch"], [50, "g", "Cheddar"], [1, "Stück", "Zwiebel"],
    [1, "Teelöffel", "Öl"], [1, "Esslöffel", "Mayo Light"], [1, "Teelöffel", "Senf"],
    [1, "Esslöffel", "Ketchup"], [2, "Esslöffel", "Joghurt"], [20, "Milliliter", "Gurkenwasser"],
    [1, "Prise", "Salz"], [1, "Prise", "Pfeffer"], [1, "Teelöffel", "Paprikapulver"],
    [1, "Teelöffel", "Knoblauchgewürz"],
  ],
  classifications: [
    c(0, "Nudeln", "pasta", "Nudeln", "pasta", { state: "raw", category: "grain" }),
    c(1, "Parmesan", "Parmesan", "Parmesan", "parmesan", { category: "dairy", foodType: "processed_single_food" }),
    c(2, "Eisbergsalat", "iceberg lettuce", "Eisbergsalat", "lettuce", { state: "raw", category: "vegetable" }),
    c(3, "Rinderhackfleisch, mager", "lean ground beef", "Rinderhackfleisch", "ground beef", { state: "raw", category: "meat" }),
    c(4, "Cheddar", "cheddar", "Cheddar", "cheddar", { category: "dairy", foodType: "processed_single_food" }),
    c(5, "Zwiebel", "onion", "Zwiebel", "onion", { state: "raw", category: "vegetable" }),
    c(6, "Öl", "oil", "Öl", "oil", { category: "oil" }),
    // coreFoodEnglish is "mayo", not "mayonnaise". This is not a guess: with "mayonnaise" the USDA
    // lookup accepts "Mayonnaise, light" (2710220, 238 kcal), and with "mayo" every candidate is
    // gated out and the lookup reports topScore -127.5 — the exact figure production logged. The
    // earlier fixture modelled the wrong one, which is why acceptance testing reported a USDA
    // record production never reached. See PRODUCTION_USDA_MISS below.
    c(7, "Mayonnaise, leicht", "light mayo", "Mayonnaise", "mayo", { category: "condiment", foodType: "processed_single_food" }),
    c(8, "Senf", "mustard", "Senf", "mustard", { category: "condiment", foodType: "processed_single_food" }),
    c(9, "Ketchup", "ketchup", "Ketchup", "ketchup", { category: "condiment", foodType: "processed_single_food" }),
    c(10, "Joghurt", "yogurt", "Joghurt", "yogurt", { category: "dairy", foodType: "processed_single_food" }),
    c(11, "Gurkenwasser", "cucumber water", "Gurke", "cucumber", { category: "liquid" }),
    c(12, "Salz", "salt", "Salz", "salt", { category: "seasoning" }),
    c(13, "Pfeffer", "pepper", "Pfeffer", "pepper", { category: "spice" }),
    c(14, "Paprikapulver", "paprika powder", "Paprika", "paprika", { form: "powder", category: "spice" }),
    c(15, "Knoblauchgewürz", "garlic seasoning", "Knoblauch", "garlic", { category: "seasoning" }),
  ],
  llmGrams: {
    onion: 110, oil: 4.5, "light mayo": 12, mustard: 4, ketchup: 12, yogurt: 15,
    salt: 0.3, pepper: 0.4, "paprika powder": 4, "garlic seasoning": 4,
  },
  // Calibrated against production: the three LLM-sourced ingredients must account for
  // 2553.416 minus the database contributions.
  //
  // There is deliberately NO "lean ground beef" entry. Production never asked — it accepted BLS's
  // record — so there is no recorded answer to replay, and inventing one would make the fixture
  // assert a number production never produced. What this fixture therefore shows for the beef is
  // the CONSERVATIVE branch of attribute-aware routing: the chain is walked, nothing satisfies the
  // claim, and the flagged BLS record is used with `unmetAttributes` intact. The branch where an
  // estimate IS available is covered in tests/attribute-routing-e2e.test.ts.
  llmNutrients: {
    oil: { kcal: 884, protein: 0, carbs: 0, fat: 100 },
    "cucumber water": { kcal: 12, protein: 0.3, carbs: 2.5, fat: 0.1 },
    "paprika powder": { kcal: 282, protein: 14, carbs: 54, fat: 13 },
    // What production's estimator ACTUALLY returned once PR #8 let the chain reach it. Both are
    // read back from the deployed run, not modelled. The beef figure is the whole point of this
    // fixture: 250 kcal/100 g is MORE than the 224 kcal ordinary mince it was allowed to displace
    // "because it satisfied reduced-fat".
    "lean ground beef": { kcal: 250, protein: 20, carbs: 0, fat: 18 },
    "light mayo": { kcal: 50, protein: 0.5, carbs: 5, fat: 3 },
  },
  // EXACT: 2499.956 from the database rows + 53.460 from these three = 2553.416, production's own
  // total to the milli-kcal. Note this is the total production recorded, with its 490 kcal
  // Salatmayonnaise; the replay lands on the 750 kcal record (see fixtureDeviations) and so runs
  // 31.2 kcal above it on main, and 2523.176 on this branch once USDA's light record wins.
  reconcilesWithin: 0.001,
  productionRows: [
    ["Nudeln", "bls", "Teigwaren eifrei, roh", 300, 0.85],
    ["Parmesan", "bls", "Parmesan mind. 30 % Fett i. Tr.", 50, 0.85],
    ["Eisbergsalat", "bls", "Eisbergsalat roh", 200, 0.85],
    ["mageres Rinderhackfleisch", "bls", "Rind Hackfleisch, roh", 400, 0.55],
    ["Cheddar", "bls", "Chester (Cheddar) mind. 50 % Fett i. Tr.", 50, 0.85],
    ["Zwiebel", "bls", "Speisezwiebel roh", 110, 0.75],
    ["Öl", "llm-nutrient", null, 4.5, 0.35],
    ["Mayo Light", "bls", "Salatmayonnaise (Fertigprodukt)", 12, 0.55],
    ["Senf", "bls", "Senf mittelscharf", 4, 0.85],
    ["Ketchup", "bls", "Tomatenketchup", 12, 0.8],
    ["Joghurt", "bls", "Joghurt mild, mind. 3,5 % Fett", 30, 0.85],
    ["Gurkenwasser", "llm-nutrient", null, 20, 0.35],
    ["Salz", "bls", "Speisesalz/Siedesalz/Tafelsalz", 0.3, 0.75],
    ["Pfeffer", "bls", "Pfeffer schwarz, getrocknet", 0.4, 0.8],
    ["Paprikapulver", "llm-nutrient", null, 4, 0.35],
    ["Knoblauchgewürz", "usda", "Spices, garlic powder", 4, 0.7],
  ],
  fixtureDeviations: {
    // Production's BLS pick for this row was the 490 kcal "Salatmayonnaise (Fertigprodukt)",
    // reached by a rerank ("Salatmayonnaise is a type of light mayo."). The replay never gets to
    // ask: with the German spelling modelled here, BLS scores "Mayonnaise (Fertigprodukt)" 74.5
    // and "Salatmayonnaise (Fertigprodukt)" 22, and a 52.5-point gap is outside RERANK_BAND (40),
    // so no rerank is triggered and the 750 kcal record stands.
    //
    // The spelling production's classifier actually returned is NOT recoverable — provenance
    // stores canonicalEnglish ("light mayo") but no German — so this row cannot be pinned to
    // production's record without inventing the input that produces it. It is left as it falls.
    //
    // Nothing that matters turns on which of the two it is: both are full-fat, both carry
    // unmetAttributes ["reduced-fat"], both are what attribute-aware routing leaves behind for
    // USDA's 238 kcal "Mayonnaise, light". It changes only the SIZE of the improvement quoted from
    // this fixture (750 -> 238 rather than production's 490 -> 238), which is why the reconciliation
    // is computed from production's recorded provenance, not from this replay.
    "Mayo Light": {
      provider: "bls",
      record: "Mayonnaise (Fertigprodukt)",
      why: "modelled canonicalGerman puts the two BLS mayonnaise records 52.5 points apart, outside RERANK_BAND",
    },
  },
}

/** The Mealie record for the homemade paste, as the recipe provider reads it. */
export const TIKKA_PASTE_RECIPE: MealieRecipe = {
  slug: "tikka-paste",
  name: "Tikka-Paste",
  recipeYield: "g",
  recipeYieldQuantity: 800,
  recipeServings: 1,
  recipeIngredient: [],
  nutrition: {
    calories: "2872.68", proteinContent: "29", carbohydrateContent: "88", fatContent: "239",
    saturatedFatContent: "33", transFatContent: "0", unsaturatedFatContent: "206",
    fiberContent: "65", sugarContent: "29", sodiumContent: "12017", cholesterolContent: "0",
  },
  tags: [], extras: null,
}

export const PRODUCTION_RECIPES = [KIDNEY_CURRY, TIKKA_PASTE, BUTTER_CHICKEN, BIG_MAC_SALAT]
