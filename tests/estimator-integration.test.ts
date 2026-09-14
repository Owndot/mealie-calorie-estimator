import { describe, it, expect, beforeEach, beforeAll, vi } from "vitest"
import { estimateRecipe, computeIngredientHash } from "../src/services/estimator.js"
import { config } from "../src/config.js"
import { initCache } from "../src/utils/cache.js"
import { mockUsdaProvider } from "./helpers/mock-usda.js"
import type { MealieRecipe, MealieIngredient } from "../src/types.js"

function ing(overrides: Partial<MealieIngredient> = {}): MealieIngredient {
  return {
    quantity: 100,
    unit: { id: "g", name: "g", pluralName: "g", abbreviation: "g", standardQuantity: null, standardUnit: null },
    food: { id: "1", name: "Mehl", pluralName: null, aliases: [] },
    note: null,
    display: "",
    title: null,
    originalText: null,
    ...overrides,
  }
}

function recipe(overrides: Partial<MealieRecipe> = {}): MealieRecipe {
  return {
    slug: "test-recipe",
    name: "Test Recipe",
    recipeYield: null,
    recipeServings: 4,
    recipeIngredient: [],
    nutrition: null,
    tags: [],
    extras: {},
    householdId: null,
    ...overrides,
  }
}

beforeAll(async () => {
  await initCache()
})

beforeEach(() => {
  config.llm.enabled = false
  config.llm.apiKey = ""
  config.usda.apiKey = ""
  vi.restoreAllMocks()
})

describe("estimateRecipe — end to end via the real USDA provider (mocked network), LLM disabled", () => {
  it("resolves a fully-known recipe as 'complete' and divides by recipeServings exactly once", async () => {
    config.usda.apiKey = "test-key"
    mockUsdaProvider({ Mehl: { kcal: 364, protein: 10, carbs: 76, fat: 1 } })

    const r = recipe({
      recipeServings: 4,
      recipeIngredient: [ing({ quantity: 400, food: { id: "1", name: "Mehl", pluralName: null, aliases: [] } })],
    })

    const result = await estimateRecipe(r)

    expect(result.completeness).toBe("complete")
    expect(result.matchedIngredients[0].provider).toBe("usda")
    // 400g flour @ 364 kcal/100g = 1456 total kcal; /4 servings = 364/serving
    expect(result.totalNutrients.kcalPer100g).toBeCloseTo(1456, 0)
    expect(result.perServingNutrients.kcalPer100g).toBeCloseTo(364, 0)
  })

  it("never uses recipeYield for the servings divisor, even when it disagrees with recipeServings", async () => {
    config.usda.apiKey = "test-key"
    mockUsdaProvider({ Zucker: { kcal: 387, protein: 0, carbs: 100, fat: 0 } })

    const r = recipe({
      recipeServings: 2,
      recipeYield: "8 servings", // deliberately different from recipeServings
      recipeIngredient: [ing({ quantity: 200, food: { id: "1", name: "Zucker", pluralName: null, aliases: [] } })],
    })

    const result = await estimateRecipe(r)
    // 200g sugar @ 387 kcal/100g = 774 total; if recipeYield(8) were used -> ~97/serving
    // recipeServings(2) must be used -> ~387/serving
    expect(result.servings).toBe(2)
    expect(result.perServingNutrients.kcalPer100g).toBeCloseTo(387, 0)
  })

  it("does not multiply or divide individual ingredient grams by servings", async () => {
    config.usda.apiKey = "test-key"
    mockUsdaProvider({ Reis: { kcal: 130, protein: 2.7, carbs: 28, fat: 0.3 } })

    const r4 = recipe({ recipeServings: 4, recipeIngredient: [ing({ quantity: 300, food: { id: "1", name: "Reis", pluralName: null, aliases: [] } })] })
    const r8 = recipe({ recipeServings: 8, recipeIngredient: [ing({ quantity: 300, food: { id: "1", name: "Reis", pluralName: null, aliases: [] } })] })

    const result4 = await estimateRecipe(r4)
    const result8 = await estimateRecipe(r8)

    // Whole-recipe total must be identical regardless of servings; only per-serving differs.
    expect(result4.totalNutrients.kcalPer100g).toBeCloseTo(result8.totalNutrients.kcalPer100g!, 3)
    expect(result4.perServingNutrients.kcalPer100g).toBeCloseTo(result8.perServingNutrients.kcalPer100g! * 2, 0)
  })

  it("does not use recipeServings as a gram quantity", async () => {
    config.usda.apiKey = "test-key"
    mockUsdaProvider({ Mehl: { kcal: 364, protein: 10, carbs: 76, fat: 1 } })

    const r = recipe({
      recipeServings: 400, // suspiciously matches the intended gram quantity of an ingredient
      recipeIngredient: [ing({ quantity: 100, food: { id: "1", name: "Mehl", pluralName: null, aliases: [] } })],
    })
    const result = await estimateRecipe(r)
    // 100g flour, not 400g — servings must never leak into the gram/provider-lookup path
    expect(result.totalNutrients.kcalPer100g).toBeCloseTo(364, 0)
  })

  it("a minor unresolved seasoning does not crash the recipe and is classified 'partial', not 'withheld'", async () => {
    config.usda.apiKey = "test-key"
    mockUsdaProvider({ Mehl: { kcal: 364, protein: 10, carbs: 76, fat: 1 } }) // "seltene-gewuerzmischung-xyz" deliberately absent -> unresolved

    const r = recipe({
      recipeServings: 4,
      recipeIngredient: [
        ing({ quantity: 400, food: { id: "1", name: "Mehl", pluralName: null, aliases: [] } }),
        ing({ quantity: 1, unit: { id: "g2", name: "Prise", pluralName: null, abbreviation: null, standardQuantity: null, standardUnit: null }, food: { id: "2", name: "seltene-gewuerzmischung-xyz", pluralName: null, aliases: [] } }),
      ],
    })

    const result = await estimateRecipe(r)
    expect(result.unmatchedCount).toBe(1)
    expect(result.completeness).toBe("partial")
    expect(result.totalNutrients.kcalPer100g).not.toBeNull()
  })

  it("a significant unresolved calorie-dense ingredient withholds nutrition rather than reporting a misleadingly complete result", async () => {
    config.usda.apiKey = "test-key"
    mockUsdaProvider({ Mehl: { kcal: 364, protein: 10, carbs: 76, fat: 1 } }) // the 400g main ingredient deliberately has no USDA match

    const r = recipe({
      recipeServings: 4,
      recipeIngredient: [
        ing({ quantity: 100, food: { id: "1", name: "Mehl", pluralName: null, aliases: [] } }),
        ing({ quantity: 400, food: { id: "2", name: "totally-unrecognizable-main-ingredient-xyz", pluralName: null, aliases: [] } }),
      ],
    })

    const result = await estimateRecipe(r)
    expect(result.matchedIngredients.some((i) => i.matched)).toBe(true) // Mehl did resolve
    expect(result.completeness).toBe("withheld")
    expect(result.totalNutrients.kcalPer100g).toBeNull()
    expect(result.perServingNutrients.kcalPer100g).toBeNull()
  })

  it("missing/unresolved nutrients are never silently converted to zero", async () => {
    const r = recipe({
      recipeServings: 4,
      recipeIngredient: [ing({ quantity: 100, food: { id: "1", name: "totally-unrecognizable-food-xyz", pluralName: null, aliases: [] } })],
    })
    const result = await estimateRecipe(r)
    expect(result.totalNutrients.kcalPer100g).toBeNull() // not 0
    expect(result.matchedIngredients[0].matched).toBe(false)
  })

  it("originalText never influences the hash or the estimate, even when it contradicts structured data", async () => {
    const withSuspiciousOriginalText = recipe({
      recipeServings: 4,
      recipeIngredient: [
        ing({
          quantity: 3,
          unit: { id: "u1", name: "Stück", pluralName: null, abbreviation: null, standardQuantity: null, standardUnit: null },
          food: { id: "1", name: "Ei", pluralName: null, aliases: [] },
          originalText: "Eier (2 gekocht - mit @organicvalley)",
        }),
      ],
    })
    const withoutOriginalText = recipe({
      recipeServings: 4,
      recipeIngredient: [
        ing({
          quantity: 3,
          unit: { id: "u1", name: "Stück", pluralName: null, abbreviation: null, standardQuantity: null, standardUnit: null },
          food: { id: "1", name: "Ei", pluralName: null, aliases: [] },
          originalText: null,
        }),
      ],
    })

    expect(computeIngredientHash(withSuspiciousOriginalText)).toBe(computeIngredientHash(withoutOriginalText))

    const resultA = await estimateRecipe(withSuspiciousOriginalText)
    const resultB = await estimateRecipe(withoutOriginalText)
    expect(resultA.matchedIngredients[0].grams).toBe(resultB.matchedIngredients[0].grams)
    expect(resultA.matchedIngredients[0].brand).toBeNull()
    // structured quantity (3 Stück) is used, not the "2" implied by originalText
    expect(resultA.matchedIngredients[0].grams).toBe(159) // 3 * 53g/egg
  })
})
