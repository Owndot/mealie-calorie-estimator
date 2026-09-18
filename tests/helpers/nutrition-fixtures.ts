import type { FoodAttributes, FoodState, FoodType } from "../../src/types.js"
import { inferAttributesFromName } from "../../src/services/providers/food-semantics.js"

/**
 * Recipe-level fixtures reproducing the manually-tested recipes that exposed the nutrition-quality
 * problems. They drive the REAL BLS database (bundled, deterministic) while OFF and USDA are
 * served from recorded response shapes, so a run is reproducible and a regression is attributable.
 *
 * Assertions built on these deliberately check plausible ranges, provider choice, semantic identity
 * and arithmetic invariants rather than one magic calorie number — the totals depend on which
 * database record wins, which is exactly what is under test.
 */

export interface FixtureIngredient {
  name: string
  canonicalGerman: string
  canonicalEnglish: string
  coreFoodGerman: string
  coreFoodEnglish: string
  grams: number
  state: FoodState
  foodType: FoodType
  category?: string | null
  brand?: string | null
  /** Omitted => derived from the name, exactly as the deterministic normalizer backstop does. */
  attributes?: Partial<FoodAttributes>
}

export interface RecipeFixture {
  slug: string
  name: string
  servings: number
  ingredients: FixtureIngredient[]
}

export function attributesOf(i: FixtureIngredient): FoodAttributes {
  const inferred = inferAttributesFromName(`${i.name} ${i.canonicalGerman}`)
  return {
    form: i.attributes?.form ?? inferred.form,
    preservation: i.attributes?.preservation ?? inferred.preservation,
    fatPercent: i.attributes?.fatPercent ?? inferred.fatPercent,
  }
}

const g = (
  name: string, de: string, en: string, coreDe: string, coreEn: string, grams: number,
  state: FoodState = "unknown", foodType: FoodType = "simple",
  extra: Partial<FixtureIngredient> = {},
): FixtureIngredient => ({ name, canonicalGerman: de, canonicalEnglish: en, coreFoodGerman: coreDe, coreFoodEnglish: coreEn, grams, state, foodType, ...extra })

export const BUTTER_CHICKEN: RecipeFixture = {
  slug: "fixture-butter-chicken",
  name: "Butter Chicken",
  servings: 4,
  ingredients: [
    g("Hähnchenbrust", "Hähnchenbrust", "chicken breast", "Hähnchenbrust", "chicken breast", 600, "raw"),
    g("Butter", "Butter", "butter", "Butter", "butter", 40, "unknown"),
    g("Zwiebel", "Zwiebel", "onion", "Zwiebel", "onion", 150, "raw"),
    g("Knoblauch", "Knoblauch", "garlic", "Knoblauch", "garlic", 15, "raw"),
    g("Ingwer frisch", "Ingwer, frisch", "fresh ginger", "Ingwer", "ginger", 20, "raw"),
    g("Kreuzkümmel gemahlen", "Kreuzkümmel, gemahlen", "ground cumin", "Kreuzkümmel", "cumin", 4, "dried", "processed_single_food"),
    g("Tomatenmark", "Tomatenmark", "tomato paste", "Tomatenmark", "tomato paste", 70, "unknown", "processed_single_food"),
    g("Kochsahne 15%", "Kochsahne 15 % Fett", "cooking cream 15% fat", "Sahne", "cream", 200, "unknown", "processed_single_food",
      { attributes: { fatPercent: 15 } }),
  ],
}

export const KIDNEY_BEAN_CURRY: RecipeFixture = {
  slug: "fixture-kidney-bean-curry",
  name: "Kidney-bean tomato curry",
  servings: 2,
  ingredients: [
    g("Kidneybohnen a. d. Dose", "Kidneybohnen, Konserve, abgetropft", "canned kidney beans, drained",
      "Kidneybohne", "kidney bean", 240, "unknown", "processed_single_food"),
    g("Kokosmilch", "Kokosmilch", "coconut milk", "Kokosmilch", "coconut milk", 200, "unknown", "processed_single_food"),
    g("Zwiebel", "Zwiebel", "onion", "Zwiebel", "onion", 110, "raw"),
    g("Knoblauch", "Knoblauch", "garlic", "Knoblauch", "garlic", 10, "raw"),
    g("Ingwer", "Ingwer", "ginger", "Ingwer", "ginger", 15, "unknown"),
    g("Tomatenmark", "Tomatenmark", "tomato paste", "Tomatenmark", "tomato paste", 60, "unknown", "processed_single_food"),
    g("Basmati-Reis", "Basmati-Reis", "basmati rice", "Reis", "rice", 150, "raw"),
  ],
}

export const BIG_MAC_SALAD: RecipeFixture = {
  slug: "fixture-big-mac-salad",
  name: "Big Mac salad",
  servings: 3,
  ingredients: [
    g("mageres Rinderhackfleisch", "Rinderhackfleisch, mager", "lean ground beef", "Rinderhackfleisch", "ground beef", 400, "raw"),
    g("Eisbergsalat", "Eisbergsalat", "iceberg lettuce", "Eisbergsalat", "lettuce", 200, "raw"),
    g("Cheddar", "Cheddar", "cheddar", "Cheddar", "cheddar", 50, "unknown", "processed_single_food"),
    g("Parmesan", "Parmesan", "parmesan", "Parmesan", "parmesan", 50, "unknown", "processed_single_food"),
    g("Zwiebel", "Zwiebel", "onion", "Zwiebel", "onion", 60, "raw"),
  ],
}

export const RECIPE_FIXTURES = [BUTTER_CHICKEN, KIDNEY_BEAN_CURRY, BIG_MAC_SALAD]

/**
 * Recorded OFF/USDA response shapes for the products these recipes actually surfaced live. Keyed
 * by the English query text a provider would search with. Anything not listed returns no hits,
 * which is what makes "did this fall through to the LLM?" observable in a test.
 */
export const OFF_HITS: Record<string, unknown[]> = {
  "pasta": [{ product_name: "Pasta", brands: ["Barilla"], nutriments: { "energy-kcal_100g": 358 }, categories_tags: [] }],
  // The branded route searches "<brand> <food>", so a branded lookup needs its own key.
  "barilla pasta": [{ product_name: "Pasta", brands: ["Barilla"], nutriments: { "energy-kcal_100g": 358 }, categories_tags: [] }],
  "parmesan": [{ product_name: "Billa Bio Parmesan", brands: ["Billa"], nutriments: { "energy-kcal_100g": 402 }, categories_tags: [] }],
  "cheddar": [{ product_name: "Castello Cheddar", brands: ["Castello"], nutriments: { "energy-kcal_100g": 394 }, categories_tags: [] }],
  "lean ground beef": [{ product_name: "Publix Lean Ground Beef", brands: ["Publix"], nutriments: { "energy-kcal_100g": 240 }, categories_tags: [] }],
  "basmati rice": [{ product_name: "Basmati Rice", brands: ["Tilda"], nutriments: { "energy-kcal_100g": 349 }, categories_tags: [] }],
  "iceberg lettuce": [{ product_name: "Lettuce", brands: ["Kroger"], nutriments: { "energy-kcal_100g": 15 }, categories_tags: [] }],
}

const kcal = (v: number, fat = 0) => [
  { nutrientId: 1008, nutrientName: "Energy", unitName: "KCAL", value: v },
  { nutrientId: 1004, nutrientName: "Total lipid (fat)", unitName: "G", value: fat },
]

export const USDA_HITS: Record<string, unknown[]> = {
  "ginger": [{ fdcId: 170926, description: "Spices, ginger, ground", dataType: "SR Legacy", foodNutrients: kcal(335, 4.2) }],
  "fresh ginger": [{ fdcId: 170926, description: "Spices, ginger, ground", dataType: "SR Legacy", foodNutrients: kcal(335, 4.2) }],
  "ground cumin": [{ fdcId: 170923, description: "Spices, cumin seed", dataType: "SR Legacy", foodNutrients: kcal(375, 22.3) }],
  "canned kidney beans, drained": [{ fdcId: 2345678, description: "Kidney beans, NFS", dataType: "Survey (FNDDS)", foodNutrients: kcal(127, 0.5) }],
  "chicken breast": [{ fdcId: 171477, description: "Chicken, broiler, breast, meat only, raw", dataType: "SR Legacy", foodNutrients: kcal(114, 2.6) }],
  "tomato paste": [{ fdcId: 170459, description: "Tomato products, canned, paste", dataType: "SR Legacy", foodNutrients: kcal(82, 0.5) }],

  // Verbatim candidate sets from the live FoodData Central API (2026-09, pageSize 25, Branded
  // entries dropped exactly as the generic route does), for the ingredients the real-recipe
  // validation got wrong. Recorded rather than invented so a regression test asserts what USDA
  // actually offers — including that the CORRECT record was present and lost.
  "canned kidney beans": [
    { fdcId: 2341573, description: "Kidney beans, from canned, fat added", dataType: "Survey (FNDDS)", foodCategory: "Beans, peas, legumes", foodNutrients: kcal(186, 8.2) },
    { fdcId: 2341574, description: "Kidney beans, from canned, no added fat", dataType: "Survey (FNDDS)", foodCategory: "Beans, peas, legumes", foodNutrients: kcal(135, 0.5) },
    { fdcId: 175196, description: "Beans, kidney, all types, mature seeds, canned", dataType: "SR Legacy", foodCategory: "Legumes and Legume Products", foodNutrients: kcal(84, 0.3) },
    { fdcId: 175198, description: "Beans, kidney, red, mature seeds, canned, drained solids", dataType: "SR Legacy", foodCategory: "Legumes and Legume Products", foodNutrients: kcal(124, 0.5) },
    { fdcId: 2707379, description: "Kidney beans, NFS", dataType: "Survey (FNDDS)", foodCategory: "Beans, peas, legumes", foodNutrients: kcal(177, 6.97) },
  ],
  "coriander": [
    { fdcId: 170922, description: "Spices, coriander seed", dataType: "SR Legacy", foodCategory: "Spices and Herbs", foodNutrients: kcal(298, 17.77) },
    { fdcId: 169997, description: "Coriander (cilantro) leaves, raw", dataType: "SR Legacy", foodCategory: "Vegetables and Vegetable Products", foodNutrients: kcal(23, 0.52) },
    { fdcId: 170921, description: "Spices, coriander leaf, dried", dataType: "SR Legacy", foodCategory: "Spices and Herbs", foodNutrients: kcal(279, 4.78) },
  ],
  "dried coriander": [
    { fdcId: 170922, description: "Spices, coriander seed", dataType: "SR Legacy", foodCategory: "Spices and Herbs", foodNutrients: kcal(298, 17.77) },
    { fdcId: 170921, description: "Spices, coriander leaf, dried", dataType: "SR Legacy", foodCategory: "Spices and Herbs", foodNutrients: kcal(279, 4.78) },
  ],
  "garlic seasoning": [
    { fdcId: 2345900, description: "Garlic sauce", dataType: "Survey (FNDDS)", foodCategory: "Dips, gravies, other sauces", foodNutrients: kcal(683, 72.0) },
    { fdcId: 2345901, description: "Garlic, cooked", dataType: "Survey (FNDDS)", foodCategory: "Mustard and other condiments", foodNutrients: kcal(142, 0.5) },
    { fdcId: 1104647, description: "Garlic, raw", dataType: "Foundation", foodCategory: "Vegetables and Vegetable Products", foodNutrients: kcal(143, 0.5) },
    { fdcId: 169230, description: "Garlic, raw", dataType: "SR Legacy", foodCategory: "Vegetables and Vegetable Products", foodNutrients: kcal(149, 0.5) },
    { fdcId: 171325, description: "Spices, garlic powder", dataType: "SR Legacy", foodCategory: "Spices and Herbs", foodNutrients: kcal(331, 0.73) },
  ],
  "cucumber water": [
    { fdcId: 168409, description: "Cucumber, raw", dataType: "SR Legacy", foodCategory: "Vegetables and Vegetable Products", foodNutrients: kcal(15, 0.11) },
    { fdcId: 169225, description: "Cucumber, with peel, raw", dataType: "SR Legacy", foodCategory: "Vegetables and Vegetable Products", foodNutrients: kcal(15, 0.11) },
  ],
  "pasta": [
    { fdcId: 2343000, description: "Pasta, cooked", dataType: "Survey (FNDDS)", foodCategory: "Pasta, noodles, cooked grains", foodNutrients: kcal(157, 0.9) },
    { fdcId: 168927, description: "Pasta, dry, enriched", dataType: "SR Legacy", foodCategory: "Cereal Grains and Pasta", foodNutrients: kcal(371, 1.5) },
  ],
  "mustard": [
    { fdcId: 2345432, description: "Mustard", dataType: "Survey (FNDDS)", foodCategory: "Mustard and other condiments", foodNutrients: kcal(69, 4.0) },
    { fdcId: 172281, description: "Spices, mustard seed, ground", dataType: "SR Legacy", foodCategory: "Spices and Herbs", foodNutrients: kcal(508, 36.2) },
  ],
  "ghee": [
    { fdcId: 2341061, description: "Ghee, clarified butter", dataType: "Survey (FNDDS)", foodCategory: "Butter and animal fats", foodNutrients: kcal(876, 99.5) },
  ],
}
