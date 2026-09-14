import type { NutrientSet, ProviderMatch } from "../../types.js"
import type { NutrientProvider, ProviderQuery } from "./types.js"

/**
 * Small built-in reference table of common generic ingredients (German + English names),
 * used as the first, always-available generic-route provider — ahead of any network fallback.
 *
 * These are illustrative typical per-100g values (same order of magnitude as public USDA/OFF
 * data), hand-authored for this project. They are NOT derived from, nor a substitute for,
 * licensed BLS data — see the BLS provider slot for that (kept empty pending licensing review).
 * Extend this table (or wire in a licensed local dataset via a real provider) as coverage gaps
 * are found; do not use it to bundle or redistribute a licensed dataset.
 */
interface GenericEntry {
  canonicalName: string
  aliases: string[]
  nutrients: NutrientSet
}

function n(
  kcal: number,
  protein: number,
  carbs: number,
  fat: number,
  extra: Partial<NutrientSet> = {},
): NutrientSet {
  return {
    kcalPer100g: kcal,
    proteinPer100g: protein,
    carbsPer100g: carbs,
    fatPer100g: fat,
    saturatedFatPer100g: extra.saturatedFatPer100g ?? null,
    transFatPer100g: extra.transFatPer100g ?? null,
    unsaturatedFatPer100g: extra.unsaturatedFatPer100g ?? null,
    fiberPer100g: extra.fiberPer100g ?? null,
    sugarPer100g: extra.sugarPer100g ?? null,
    sodiumPer100g: extra.sodiumPer100g ?? null,
    cholesterolPer100g: extra.cholesterolPer100g ?? null,
  }
}

const GENERIC_FOODS: GenericEntry[] = [
  { canonicalName: "Weizenmehl", aliases: ["mehl", "weizenmehl", "flour", "all-purpose flour", "vollkornmehl", "wheat flour"], nutrients: n(364, 10.3, 76.3, 1.0, { saturatedFatPer100g: 0.2, fiberPer100g: 2.7, sugarPer100g: 0.4, sodiumPer100g: 0.002 }) },
  { canonicalName: "Zucker", aliases: ["zucker", "sugar", "haushaltszucker", "white sugar"], nutrients: n(387, 0, 100, 0, { sugarPer100g: 100, sodiumPer100g: 0 }) },
  { canonicalName: "Butter", aliases: ["butter"], nutrients: n(717, 0.9, 0.1, 81, { saturatedFatPer100g: 51, sodiumPer100g: 0.011, cholesterolPer100g: 0.215 }) },
  { canonicalName: "Ei", aliases: ["ei", "eier", "egg", "eggs"], nutrients: n(155, 13, 1.1, 11, { saturatedFatPer100g: 3.3, sugarPer100g: 0.3, sodiumPer100g: 0.14, cholesterolPer100g: 0.373 }) },
  { canonicalName: "Milch", aliases: ["milch", "milk", "vollmilch", "whole milk"], nutrients: n(64, 3.4, 4.8, 3.6, { saturatedFatPer100g: 2.3, sugarPer100g: 4.8, sodiumPer100g: 0.044, cholesterolPer100g: 0.014 }) },
  { canonicalName: "Salz", aliases: ["salz", "salt", "meersalz", "kochsalz", "speisesalz"], nutrients: n(0, 0, 0, 0, { sodiumPer100g: 38.75 }) },
  { canonicalName: "Olivenöl", aliases: ["olivenöl", "olivenoel", "olive oil", "öl", "oel", "oil"], nutrients: n(884, 0, 0, 100, { saturatedFatPer100g: 14, unsaturatedFatPer100g: 86 }) },
  { canonicalName: "Reis", aliases: ["reis", "rice", "basmatireis", "basmati rice"], nutrients: n(130, 2.7, 28, 0.3, { fiberPer100g: 0.4, sodiumPer100g: 0.001 }) },
  { canonicalName: "Nudeln", aliases: ["nudeln", "pasta", "spaghetti", "penne", "teigwaren"], nutrients: n(131, 5, 25, 1.1, { fiberPer100g: 1.8, sodiumPer100g: 0.006 }) },
  { canonicalName: "Zwiebel", aliases: ["zwiebel", "zwiebeln", "onion", "onions"], nutrients: n(40, 1.1, 9.3, 0.1, { fiberPer100g: 1.7, sugarPer100g: 4.2, sodiumPer100g: 0.004 }) },
  { canonicalName: "Knoblauch", aliases: ["knoblauch", "garlic"], nutrients: n(149, 6.4, 33, 0.5, { fiberPer100g: 2.1, sodiumPer100g: 0.017 }) },
  { canonicalName: "Tomate", aliases: ["tomate", "tomaten", "tomato", "tomatoes"], nutrients: n(18, 0.9, 3.9, 0.2, { fiberPer100g: 1.2, sugarPer100g: 2.6, sodiumPer100g: 0.005 }) },
  { canonicalName: "Kartoffel", aliases: ["kartoffel", "kartoffeln", "potato", "potatoes"], nutrients: n(77, 2, 17, 0.1, { fiberPer100g: 2.2, sodiumPer100g: 0.006 }) },
  { canonicalName: "Karotte", aliases: ["karotte", "karotten", "möhre", "moehre", "carrot", "carrots"], nutrients: n(41, 0.9, 9.6, 0.2, { fiberPer100g: 2.8, sugarPer100g: 4.7, sodiumPer100g: 0.069 }) },
  { canonicalName: "Hähnchenbrust", aliases: ["hähnchenbrust", "haehnchenbrust", "chicken breast", "hähnchenbrustfilet"], nutrients: n(165, 31, 0, 3.6, { saturatedFatPer100g: 1, sodiumPer100g: 0.074, cholesterolPer100g: 0.085 }) },
  { canonicalName: "Rinderhack", aliases: ["rinderhack", "hackfleisch", "ground beef", "beef mince"], nutrients: n(254, 17.2, 0, 20, { saturatedFatPer100g: 7.9, sodiumPer100g: 0.066, cholesterolPer100g: 0.078 }) },
  { canonicalName: "Speck", aliases: ["speck", "bacon"], nutrients: n(541, 37, 1.4, 42, { saturatedFatPer100g: 14, sodiumPer100g: 1.7, cholesterolPer100g: 0.11 }) },
  { canonicalName: "Käse", aliases: ["käse", "kaese", "cheese", "emmentaler", "gouda", "cheddar"], nutrients: n(380, 27, 1.3, 30, { saturatedFatPer100g: 19, sodiumPer100g: 0.6, cholesterolPer100g: 0.1 }) },
  { canonicalName: "Joghurt", aliases: ["joghurt", "yogurt", "yoghurt", "naturjoghurt"], nutrients: n(61, 3.5, 4.7, 3.3, { saturatedFatPer100g: 2.1, sugarPer100g: 4.7, sodiumPer100g: 0.046, cholesterolPer100g: 0.013 }) },
  { canonicalName: "Sahne", aliases: ["sahne", "cream", "schlagsahne", "heavy cream"], nutrients: n(292, 2.1, 3.4, 30, { saturatedFatPer100g: 19, sugarPer100g: 3.4, sodiumPer100g: 0.043, cholesterolPer100g: 0.11 }) },
  { canonicalName: "Honig", aliases: ["honig", "honey"], nutrients: n(304, 0.3, 82.4, 0, { sugarPer100g: 82.1, sodiumPer100g: 0.004 }) },
  { canonicalName: "Haferflocken", aliases: ["haferflocken", "oats", "rolled oats"], nutrients: n(379, 13.5, 60, 7, { saturatedFatPer100g: 1.2, fiberPer100g: 10, sodiumPer100g: 0.002 }) },
  { canonicalName: "Paprika", aliases: ["paprika", "bell pepper", "paprikaschote"], nutrients: n(31, 1, 6, 0.3, { fiberPer100g: 2.1, sugarPer100g: 4.2, sodiumPer100g: 0.004 }) },
  { canonicalName: "Zitrone", aliases: ["zitrone", "lemon"], nutrients: n(29, 1.1, 9.3, 0.3, { fiberPer100g: 2.8, sugarPer100g: 2.5, sodiumPer100g: 0.002 }) },
  { canonicalName: "Apfel", aliases: ["apfel", "äpfel", "apple", "apples"], nutrients: n(52, 0.3, 14, 0.2, { fiberPer100g: 2.4, sugarPer100g: 10, sodiumPer100g: 0.001 }) },
  { canonicalName: "Banane", aliases: ["banane", "bananen", "banana", "bananas"], nutrients: n(89, 1.1, 23, 0.3, { fiberPer100g: 2.6, sugarPer100g: 12, sodiumPer100g: 0.001 }) },
  { canonicalName: "Spinat", aliases: ["spinat", "spinach"], nutrients: n(23, 2.9, 3.6, 0.4, { fiberPer100g: 2.2, sugarPer100g: 0.4, sodiumPer100g: 0.079 }) },
  { canonicalName: "Brokkoli", aliases: ["brokkoli", "broccoli"], nutrients: n(34, 2.8, 6.6, 0.4, { fiberPer100g: 2.6, sugarPer100g: 1.7, sodiumPer100g: 0.033 }) },
  { canonicalName: "Petersilie", aliases: ["petersilie", "parsley"], nutrients: n(36, 3, 6.3, 0.8, { fiberPer100g: 3.3, sodiumPer100g: 0.056 }) },
  { canonicalName: "Lauch", aliases: ["lauch", "porree", "leek", "leeks"], nutrients: n(61, 1.5, 14.2, 0.3, { fiberPer100g: 1.8, sugarPer100g: 3.9, sodiumPer100g: 0.02 }) },
  { canonicalName: "Sellerie", aliases: ["sellerie", "celery"], nutrients: n(16, 0.7, 3, 0.2, { fiberPer100g: 1.6, sodiumPer100g: 0.08 }) },
  { canonicalName: "Champignon", aliases: ["champignon", "champignons", "pilze", "mushroom", "mushrooms"], nutrients: n(22, 3.1, 3.3, 0.3, { fiberPer100g: 1, sugarPer100g: 2, sodiumPer100g: 0.005 }) },
  { canonicalName: "Erbsen", aliases: ["erbsen", "peas", "green peas"], nutrients: n(81, 5.4, 14.5, 0.4, { fiberPer100g: 5.7, sugarPer100g: 5.7, sodiumPer100g: 0.005 }) },
  { canonicalName: "Linsen", aliases: ["linsen", "lentils"], nutrients: n(116, 9, 20, 0.4, { fiberPer100g: 7.9, sodiumPer100g: 0.002 }) },
  { canonicalName: "Kichererbsen", aliases: ["kichererbsen", "chickpeas", "garbanzo"], nutrients: n(164, 8.9, 27.4, 2.6, { fiberPer100g: 7.6, sodiumPer100g: 0.007 }) },
  { canonicalName: "Quinoa", aliases: ["quinoa"], nutrients: n(120, 4.4, 21.3, 1.9, { fiberPer100g: 2.8, sodiumPer100g: 0.007 }) },
  { canonicalName: "Backpulver", aliases: ["backpulver", "baking powder"], nutrients: n(53, 0, 27.7, 0, { sodiumPer100g: 10.6 }) },
  { canonicalName: "Hefe", aliases: ["hefe", "yeast", "trockenhefe"], nutrients: n(325, 40, 41, 7.6, { fiberPer100g: 26.9, sodiumPer100g: 0.051 }) },
  { canonicalName: "Essig", aliases: ["essig", "vinegar"], nutrients: n(21, 0, 0.9, 0, { sugarPer100g: 0.4, sodiumPer100g: 0.002 }) },
  { canonicalName: "Sojasauce", aliases: ["sojasauce", "soy sauce", "soja sauce"], nutrients: n(53, 8, 4.9, 0.1, { sodiumPer100g: 5.5 }) },
  { canonicalName: "Senf", aliases: ["senf", "mustard"], nutrients: n(66, 4.4, 5.8, 3.3, { sodiumPer100g: 1.1 }) },
  { canonicalName: "Ketchup", aliases: ["ketchup"], nutrients: n(101, 1.2, 24, 0.2, { sugarPer100g: 21.3, sodiumPer100g: 0.99 }) },
  { canonicalName: "Mayonnaise", aliases: ["mayonnaise", "mayo"], nutrients: n(680, 1.1, 2.6, 75, { saturatedFatPer100g: 6, sodiumPer100g: 0.57, cholesterolPer100g: 0.26 }) },
  { canonicalName: "Parmesan", aliases: ["parmesan", "parmigiano"], nutrients: n(392, 35.8, 3.2, 26, { saturatedFatPer100g: 17, sodiumPer100g: 1.5, cholesterolPer100g: 0.088 }) },
  { canonicalName: "Mozzarella", aliases: ["mozzarella"], nutrients: n(280, 22, 2.2, 21, { saturatedFatPer100g: 13, sodiumPer100g: 0.37, cholesterolPer100g: 0.06 }) },
  { canonicalName: "Schinken", aliases: ["schinken", "ham"], nutrients: n(145, 21, 1.5, 5.5, { saturatedFatPer100g: 1.8, sodiumPer100g: 1.2, cholesterolPer100g: 0.053 }) },
  { canonicalName: "Lachs", aliases: ["lachs", "salmon"], nutrients: n(208, 20, 0, 13, { saturatedFatPer100g: 3.1, sodiumPer100g: 0.059, cholesterolPer100g: 0.055 }) },
  { canonicalName: "Thunfisch", aliases: ["thunfisch", "tuna"], nutrients: n(132, 28, 0, 1.3, { saturatedFatPer100g: 0.3, sodiumPer100g: 0.039, cholesterolPer100g: 0.038 }) },
  { canonicalName: "Garnelen", aliases: ["garnelen", "shrimp", "prawns"], nutrients: n(99, 24, 0.2, 0.3, { sodiumPer100g: 0.111, cholesterolPer100g: 0.152 }) },
  { canonicalName: "Rindfleisch", aliases: ["rindfleisch", "beef"], nutrients: n(217, 26.1, 0, 12, { saturatedFatPer100g: 4.9, sodiumPer100g: 0.06, cholesterolPer100g: 0.09 }) },
  { canonicalName: "Schweinefleisch", aliases: ["schweinefleisch", "pork"], nutrients: n(242, 27, 0, 14, { saturatedFatPer100g: 5, sodiumPer100g: 0.062, cholesterolPer100g: 0.08 }) },
  { canonicalName: "Pute", aliases: ["pute", "putenbrust", "turkey", "turkey breast"], nutrients: n(135, 29, 0, 1.7, { sodiumPer100g: 0.07, cholesterolPer100g: 0.083 }) },
]

const ALIAS_INDEX = new Map<string, GenericEntry>()
for (const entry of GENERIC_FOODS) {
  for (const alias of entry.aliases) {
    ALIAS_INDEX.set(alias.toLowerCase().trim(), entry)
  }
}

function normalize(name: string): string {
  return name.toLowerCase().trim()
}

function findEntry(foodName: string): GenericEntry | null {
  const normalized = normalize(foodName)

  const exact = ALIAS_INDEX.get(normalized)
  if (exact) return exact

  // word-boundary containment match, e.g. "frische petersilie" -> "petersilie"
  for (const [alias, entry] of ALIAS_INDEX) {
    const pattern = new RegExp(`\\b${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i")
    if (pattern.test(normalized)) return entry
  }

  return null
}

export class LocalGenericProvider implements NutrientProvider {
  readonly name = "local-generic"

  async lookup(query: ProviderQuery): Promise<ProviderMatch | null> {
    const entry = findEntry(query.foodName)
    if (!entry) return null

    return {
      nutrients: entry.nutrients,
      canonicalName: entry.canonicalName,
      brand: null,
      state: query.state,
      provider: this.name,
      providerId: entry.canonicalName,
      productName: entry.canonicalName,
      confidence: 0.7,
    }
  }
}

export const localGenericProvider = new LocalGenericProvider()
