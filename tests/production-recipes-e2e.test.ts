import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest"
import { config } from "../src/config.js"
import { initCache } from "../src/utils/cache.js"
import { recipe, runPipeline, row, formatRows, type ClassificationStub } from "./helpers/e2e-pipeline.js"
import { __resetRecipeIndexForTests } from "../src/services/providers/mealie-recipe-provider.js"
import type { MealieRecipe } from "../src/types.js"

/**
 * The three real recipes used for production acceptance, driven end to end. These are the numbers
 * the report quotes; if a change moves them, this file says so.
 *
 * Printing the per-ingredient breakdown is deliberate — the kidney-bean regression was a single
 * line in a table nobody could see from a provider test.
 */
const served: Record<string, MealieRecipe> = {}
vi.mock("../src/services/mealie-client.js", () => ({
  listRecipeNames: vi.fn(async () => Object.values(served).map((r) => ({ slug: r.slug, name: r.name }))),
  getRecipe: vi.fn(async (slug: string) => {
    if (!served[slug]) throw new Error(`404 ${slug}`)
    return served[slug]
  }),
  getRecipeHouseholdId: vi.fn(() => null),
  patchRecipe: vi.fn(async () => {}),
  getOrCreateTags: vi.fn(async () => []),
  getAllRecipes: vi.fn(async () => Object.keys(served)),
}))

beforeAll(async () => {
  await initCache()
})

beforeEach(() => {
  config.usda.retryBackoffMs = 1
  config.openFoodFacts.retryBackoffMs = 1
  config.mealieRecipeSource.enabled = true
  for (const k of Object.keys(served)) delete served[k]
  // The name index is module-level and TTL'd; without this a later test inherits an earlier one's
  // (possibly empty) view of the user's recipes.
  __resetRecipeIndexForTests()
})

afterEach(() => {
  config.llm.enabled = false
  config.llm.apiKey = ""
})

const kcal = (v: number, fat = 0) => [
  { nutrientId: 1008, nutrientName: "Energy", unitName: "KCAL", value: v },
  { nutrientId: 1004, nutrientName: "Total lipid (fat)", unitName: "G", value: fat },
]

const c = (
  index: number, de: string, en: string, coreDe: string, coreEn: string,
  over: Partial<ClassificationStub> = {},
): ClassificationStub => ({ index, canonicalGerman: de, canonicalEnglish: en, coreFoodGerman: coreDe, coreFoodEnglish: coreEn, ...over })

/** The homemade Tikka-Paste recipe, exactly as Mealie holds it. */
const TIKKA_PASTE: MealieRecipe = {
  slug: "tikka-paste-1", name: "Tikka-Paste",
  recipeYield: "g", recipeYieldQuantity: 800, recipeServings: 1,
  recipeIngredient: [],
  nutrition: {
    calories: "2595", proteinContent: "29", carbohydrateContent: "88", fatContent: "239",
    saturatedFatContent: "33", transFatContent: "0", unsaturatedFatContent: "206",
    fiberContent: "65", sugarContent: "29", sodiumContent: "12017", cholesterolContent: "0",
  },
  tags: [], extras: null,
}

describe("Kidney-Bohnen-Tomaten-Curry (the calorie regression)", () => {
  it("resolves the beans from BLS and reports the per-ingredient breakdown", async () => {
    const r = await runPipeline(recipe("curry", 2, [
      [2, "Stück", "Knoblauchzehen"], [5, "Gramm", "Ingwer"], [0.5, "Stück", "Limette"],
      [5, "Gramm", "Koriander"], [200, "Gramm", "Tomate"], [1, "Stück", "Zwiebel"],
      [100, "Gramm", "Basmati-Reis"], [200, "Milliliter", "Kokosmilch"],
      [400, "Gramm", "Kidneybohnen a. d. Dose"], [2, "Esslöffel", "Olivenöl"],
      [1, "Prise", "Salz"], [1, "Prise", "Pfeffer"], [2, "Teelöffel", "Curry"],
    ]), {
      classifications: [
        c(0, "Knoblauchzehen", "garlic cloves", "Knoblauch", "garlic", { state: "raw", category: "vegetable" }),
        c(1, "Ingwer", "ginger", "Ingwer", "ginger", { state: "raw", category: "spice" }),
        c(2, "Limette", "lime", "Limette", "lime", { state: "raw", category: "fruit" }),
        c(3, "Koriander", "coriander", "Koriander", "coriander", { category: "herb" }),
        c(4, "Tomaten", "tomatoes", "Tomaten", "tomatoes", { state: "raw", category: "vegetable" }),
        c(5, "Zwiebel", "onion", "Zwiebel", "onion", { state: "raw", category: "vegetable" }),
        c(6, "Basmati-Reis", "basmati rice", "Reis", "rice", { state: "raw", category: "grain" }),
        c(7, "Kokosmilch", "coconut milk", "Kokosmilch", "coconut milk", { category: "dairy" }),
        // The plural core that broke production.
        c(8, "Kidneybohnen aus der Dose", "canned kidney beans", "Kidneybohnen", "kidney beans",
          { preservation: "canned", category: "legume", foodType: "processed_single_food" }),
        c(9, "Olivenöl", "olive oil", "Olivenöl", "olive oil", { category: "oil" }),
        c(10, "Salz", "salt", "Salz", "salt", { category: "seasoning" }),
        c(11, "Pfeffer", "pepper", "Pfeffer", "pepper", { category: "spice" }),
        c(12, "Curry", "curry powder", "Curry", "curry powder", { category: "spice" }),
      ],
      usda: {
        "canned kidney beans": [
          { fdcId: 2707379, description: "Kidney beans, NFS", dataType: "Survey (FNDDS)", foodCategory: "Beans, peas, legumes", foodNutrients: kcal(177, 6.97) },
        ],
      },
      llmNutrients: { "curry powder": { kcal: 325, protein: 14, carbs: 56, fat: 14 } },
      llmGrams: { lime: 50, "garlic cloves": 3, onion: 110, "olive oil": 13.6, salt: 0.3, pepper: 0.4, "curry powder": 4 },
    })

    // eslint-disable-next-line no-console
    console.log(`\n=== Kidney-Bohnen-Tomaten-Curry (${r.perServingKcal} kcal/serving, ${r.matchQuality}) ===\n${formatRows(r)}`)

    const beans = row(r, "Kidneybohnen a. d. Dose")
    expect(beans.provider).toBe("bls")
    expect(beans.productName).toMatch(/Konserve/)
    expect(beans.kcalPer100g!).toBeLessThan(200)
    // 400 g at 128 kcal/100 g = 512, against USDA's 708. That difference is the whole regression.
    expect(beans.kcalContribution).toBeCloseTo(512, 0)

    expect(row(r, "Tomate").provider).toBe("bls")
    expect(row(r, "Basmati-Reis").productName).toMatch(/Reis/)
    expect(row(r, "Kokosmilch").productName).toMatch(/Kokosmilch/)
  })
})

describe("Butter Chicken (the homemade-ingredient case)", () => {
  it("draws Tikka-Paste from the user's own recipe instead of an LLM guess", async () => {
    served[TIKKA_PASTE.slug] = TIKKA_PASTE

    const r = await runPipeline(recipe("butter-chicken", 4, [
      [500, "Gramm", "Hähnchenbrust"], [100, "Gramm", "Tikka-Paste"], [40, "Gramm", "Ghee"],
      [150, "Gramm", "Zwiebel"], [70, "Gramm", "Tomatenmark"],
    ]), {
      classifications: [
        c(0, "Hähnchenbrust", "chicken breast", "Hähnchenbrust", "chicken breast", { state: "raw", category: "meat" }),
        c(1, "Tikka-Paste", "tikka paste", "Tikka-Paste", "tikka paste", { category: "seasoning", foodType: "processed_single_food" }),
        c(2, "Ghee", "ghee", "Ghee", "ghee", { category: "fat" }),
        c(3, "Zwiebel", "onion", "Zwiebel", "onion", { state: "raw", category: "vegetable" }),
        c(4, "Tomatenmark", "tomato paste", "Tomatenmark", "tomato paste", { category: "vegetable", foodType: "processed_single_food" }),
      ],
      // Deliberately offered, and deliberately not used: the recipe source outranks it.
      llmNutrients: { "tikka paste": { kcal: 100, protein: 2, carbs: 10, fat: 6 } },
    })

    // eslint-disable-next-line no-console
    console.log(`\n=== Butter Chicken (${r.perServingKcal} kcal/serving, ${r.matchQuality}) ===\n${formatRows(r)}`)

    const paste = row(r, "Tikka-Paste")
    expect(paste.provider).toBe("mealie-recipe")
    expect(paste.providerId).toBe("tikka-paste-1")
    expect(paste.matchReason).toBe("exact-recipe-name")
    // 2595 kcal over an 800 g yield = 324.4/100 g, so 100 g contributes ~324 — not the LLM's 100.
    expect(paste.kcalPer100g!).toBeCloseTo(324.375, 1)
    expect(paste.kcalContribution).toBeCloseTo(324.375, 1)

    expect(row(r, "Ghee").productName).toMatch(/Butterschmalz/)
    expect(row(r, "Hähnchenbrust").productName).toMatch(/Brustfilet/)
  })

  it("falls back to the LLM estimate when the source recipe has no mass yield", async () => {
    served[TIKKA_PASTE.slug] = { ...TIKKA_PASTE, recipeYield: "Portionen", recipeYieldQuantity: 4 }

    const r = await runPipeline(recipe("butter-chicken", 4, [[100, "Gramm", "Tikka-Paste"]]), {
      classifications: [c(0, "Tikka-Paste", "tikka paste", "Tikka-Paste", "tikka paste", { category: "seasoning" })],
      llmNutrients: { "tikka paste": { kcal: 100, protein: 2, carbs: 10, fat: 6 } },
    })
    expect(row(r, "Tikka-Paste").provider).toBe("llm-nutrient")
  })
})

describe("Big Mac Salat (the condiment cases)", () => {
  it("keeps every questionable condiment honest", async () => {
    const r = await runPipeline(recipe("big-mac-salat", 3, [
      [300, "Gramm", "Nudeln"], [400, "Gramm", "mageres Rinderhackfleisch"],
      [50, "Gramm", "Cheddar"], [110, "Gramm", "Zwiebel"], [4, "Gramm", "Senf"],
      [12, "Gramm", "Mayo Light"], [20, "Milliliter", "Gurkenwasser"],
    ]), {
      classifications: [
        c(0, "Nudeln", "pasta", "Nudeln", "pasta", { state: "raw", category: "grain" }),
        c(1, "Rinderhackfleisch, mager", "lean ground beef", "Rinderhackfleisch", "ground beef", { state: "raw", category: "meat" }),
        c(2, "Cheddar", "cheddar", "Cheddar", "cheddar", { category: "dairy", foodType: "processed_single_food" }),
        c(3, "Zwiebel", "onion", "Zwiebel", "onion", { state: "raw", category: "vegetable" }),
        c(4, "Senf", "mustard", "Senf", "mustard", { category: "condiment", foodType: "processed_single_food" }),
        c(5, "Mayonnaise, leicht", "light mayonnaise", "Mayonnaise", "mayonnaise", { category: "condiment", foodType: "processed_single_food" }),
        c(6, "Gurkenwasser", "cucumber water", "Gurke", "cucumber", { category: "liquid" }),
      ],
      // A model that would accept anything: the gates, not the judge, must hold the line.
      rerank: () => '{"selected":1,"confidence":0.95,"reason":"close enough"}',
    })

    // eslint-disable-next-line no-console
    console.log(`\n=== Big Mac Salat (${r.perServingKcal} kcal/serving, ${r.matchQuality}) ===\n${formatRows(r)}`)

    expect(row(r, "Nudeln").productName).toMatch(/Teigwaren/)
    expect(row(r, "Senf").productName ?? "").not.toMatch(/süß/)
    expect(row(r, "Gurkenwasser").productName ?? "").not.toMatch(/saft|Gurke roh/i)
    // The lean claim BLS cannot answer is reported rather than pretended away.
    expect(row(r, "mageres Rinderhackfleisch").confidence!).toBeLessThanOrEqual(0.6)
    expect(r.lowConfidence).toContain("mageres Rinderhackfleisch")
  })
})

describe("confidence reflects semantic evidence, not lexical fuzziness", () => {
  it("rates unambiguously correct German compounds as confident", async () => {
    const r = await runPipeline(recipe("conf", 1, [
      [100, "Gramm", "Hähnchenbrust"], [100, "Gramm", "Zwiebel"], [3, "Gramm", "Salz"],
    ]), {
      classifications: [
        c(0, "Hähnchenbrust", "chicken breast", "Hähnchenbrust", "chicken breast", { state: "raw", category: "meat" }),
        c(1, "Zwiebel", "onion", "Zwiebel", "onion", { state: "raw", category: "vegetable" }),
        c(2, "Salz", "salt", "Salz", "salt", { category: "seasoning" }),
      ],
    })
    // All three scored 0.57 in production purely because BLS's names carry extra words.
    for (const name of ["Hähnchenbrust", "Zwiebel", "Salz"]) {
      expect(row(r, name).confidence!, name).toBeGreaterThanOrEqual(0.75)
    }
    expect(r.matchQuality).toBe("high")
  })
})
