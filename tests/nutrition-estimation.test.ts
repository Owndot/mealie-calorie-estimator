import { beforeEach, describe, expect, it, vi } from "vitest"
import { estimateRecipe, buildNutritionPatch } from "../src/services/estimator.js"
import { lookupNutrients } from "../src/services/off-client.js"
import { estimateGrams, estimateNutrients } from "../src/services/llm-estimator.js"
import { getCachedNutrients, setCachedNutrients } from "../src/utils/cache.js"
import type { MealieRecipe, NutrientSet } from "../src/types.js"

vi.mock("../src/utils/cache.js", () => ({
  getCachedNutrients: vi.fn(), setCachedNutrients: vi.fn(),
}))
vi.mock("../src/utils/rate-limiter.js", () => ({
  waitForRateLimit: vi.fn(), RateLimitType: { Search: "search" },
}))
vi.mock("../src/services/llm-estimator.js", () => ({
  estimateGrams: vi.fn(), estimateNutrients: vi.fn(),
}))

const salt: NutrientSet = {
  kcalPer100g: 0, proteinPer100g: 0, carbsPer100g: 0, fatPer100g: 0,
  saturatedFatPer100g: 0, transFatPer100g: 0, unsaturatedFatPer100g: 0,
  fiberPer100g: 0, sugarPer100g: 0, sodiumPer100g: 39300, cholesterolPer100g: 0,
}

function recipe(name: string, unitName = "g", quantity = 100): MealieRecipe {
  return {
    slug: "test", name: "Test", recipeYield: "2 servings", recipeServings: 2,
    nutrition: null, tags: [], extras: {},
    recipeIngredient: [{
      quantity, unit: { id: "1", name: unitName, pluralName: null, abbreviation: null, standardQuantity: null, standardUnit: null },
      food: { id: "1", name, pluralName: null, aliases: [] },
      note: null, display: `${quantity} ${unitName} ${name}`, title: null, originalText: null,
    }],
  }
}

function offResponse(productName?: string, kcal = 10, sodium = 0) {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
    hits: [{ product_name: productName, nutriments: { "energy-kcal_100g": kcal, "sodium_100g": sodium } }],
  })))
}

beforeEach(() => {
  vi.restoreAllMocks()
  vi.resetAllMocks()
})

describe("OFF identity validation and recipe fallback", () => {
  it.each([
    ["Aubergine", "Aubergine in tomato sauce"],
    ["Ingwer", "Miyako Japan Sushi Ingwer"],
    ["Zwiebel", "smalec"],
    ["Tomate", "Tomatensuppe"],
    ["rice", "rice pudding"],
    ["Kokosmilch", "coconut milk drink"],
    ["Kartoffeln", "fried potatoes"],
    ["flour", undefined],
  ])("rejects %s -> %s and uses LLM nutrients", async (food, product) => {
    offResponse(product)
    const fallback = { ...salt, kcalPer100g: 25, sodiumPer100g: 0 }
    vi.mocked(estimateNutrients).mockResolvedValue(fallback)
    const result = await estimateRecipe(recipe(food))
    expect(estimateNutrients).toHaveBeenCalledExactlyOnceWith(food)
    expect(result.totalNutrients.kcalPer100g).toBe(25)
    expect(result.matchedIngredients[0].llmEstimated).toBe(true)
    expect(setCachedNutrients).not.toHaveBeenCalled()
  })

  it.each([
    ["Basmati-Reis", "Basmati rice"],
    ["Kokosöl", "coconut oil"],
    ["Kokosmilch", "coconut milk"],
    ["Tomatenmark", "tomato paste"],
    ["Ingwer", "Bio Ingwer"],
    ["Zwiebeln", "onions"],
    ["Aubergine", "eggplant"],
    ["Weizenmehl", "Bio Weizenmehl"],
    ["tomato paste", "tomato paste"],
    ["BASMATI REIS", "Organic Basmati Rice"],
    ["Kokosoel", "Coconut Oil"],
    ["Eier", "Ei"],
  ])("accepts %s -> %s without LLM", async (food, product) => {
    offResponse(product)
    const result = await estimateRecipe(recipe(food))
    expect(result.totalNutrients.kcalPer100g).toBe(10)
    expect(estimateNutrients).not.toHaveBeenCalled()
    expect(setCachedNutrients).toHaveBeenCalledOnce()
  })

  it("leaves a rejected match unmatched if LLM is unavailable", async () => {
    offResponse("smalec")
    vi.mocked(estimateNutrients).mockResolvedValue(null)
    const result = await estimateRecipe(recipe("Zwiebel"))
    expect(result.unmatchedIngredients).toEqual(["Zwiebel"])
    expect(result.totalNutrients.kcalPer100g).toBeNull()
  })

  it("bypasses legacy cache entries", async () => {
    vi.mocked(getCachedNutrients).mockImplementation(key => key === "Zwiebel" ? salt : undefined)
    offResponse("smalec")
    expect((await lookupNutrients("Zwiebel")).matched).toBe(false)
    expect(getCachedNutrients).toHaveBeenCalledWith("nutrition-v3:off:Zwiebel")
  })

  it("validates the food after removing the unit prefix", async () => {
    offResponse("Salz", 0, 39.3)
    expect((await lookupNutrients("Prise Salz", "Prise")).matched).toBe(true)
  })
})

describe("zero kcal salt", () => {
  it.each(["off", "llm"])("preserves sodium from %s for Prise Salz without estimating grams", async source => {
    offResponse(source === "off" ? "Salz" : "unrelated product", 0, 39.3)
    vi.mocked(estimateNutrients).mockResolvedValue(salt)
    const result = await estimateRecipe(recipe("Salz", "Prise", 1))
    expect(estimateGrams).not.toHaveBeenCalled()
    expect(result.matchedCount).toBe(1)
    expect(result.matchedIngredients[0].grams).toBe(0.4)
    expect(result.totalNutrients.kcalPer100g).toBe(0)
    expect(result.totalNutrients.sodiumPer100g).toBeCloseTo(157.2)
    expect(result.perServingNutrients.sodiumPer100g).toBe(79)
    const patch = buildNutritionPatch(result, "test-hash", "2 servings")
    expect(patch.nutrition.calories).toBe("0")
    expect(patch.nutrition.sodiumContent).toBe("79")
  })
})

describe("German recipe units", () => {
  it.each([
    ["TL", "Kreuzkümmel", 5], ["Teelöffel", "Currypulver", 5],
    ["EL", "Kokosöl", 15], ["Esslöffel", "Tomatenmark", 15],
    ["Prise", "Salz", 0.4], ["tl.", "Kreuzkümmel", 5],
    ["TEEL.", "Currypulver", 5], ["el.", "Kokosöl", 15],
    ["ESSL.", "Tomatenmark", 15], ["PRISE.", "Salz", 0.4],
    ["Gramm", "Salz", 1], ["Kilogramm", "Tomatenmark", 1000],
    ["Milliliter", "Kokosöl", 1], ["Liter", "Kokosöl", 1000],
  ])("converts 1 %s %s without asking the LLM for grams", async (unitName, foodName, grams) => {
    offResponse(foodName)
    const result = await estimateRecipe(recipe(foodName, unitName, 1))
    expect(result.matchedIngredients[0].grams).toBe(grams)
    expect(result.matchedCount).toBe(1)
    expect(estimateGrams).not.toHaveBeenCalled()
    expect(estimateNutrients).not.toHaveBeenCalled()
  })

  it.each(["Stk", "Stk.", "Stück", "pieces"])("uses the canonical unit for %s when a food-specific estimate is needed", async unitName => {
    offResponse("Aubergine")
    vi.mocked(estimateGrams).mockResolvedValue(300)
    const result = await estimateRecipe(recipe("Aubergine", unitName, 2))
    expect(estimateGrams).toHaveBeenCalledExactlyOnceWith(2, "piece", "Aubergine")
    expect(result.matchedIngredients[0].grams).toBe(300)
  })

  it("uses an explicit Stück weight before the LLM", async () => {
    offResponse("Aubergine")
    const input = recipe("Aubergine", "Stück", 2)
    input.recipeIngredient[0].unit!.standardQuantity = 200
    input.recipeIngredient[0].unit!.standardUnit = "Gramm"
    const result = await estimateRecipe(input)
    expect(result.matchedIngredients[0].grams).toBe(400)
    expect(estimateGrams).not.toHaveBeenCalled()
  })
})

it("converts OFF sodium and cholesterol grams to Mealie milligrams once", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ hits: [{
    product_name: "Testfood", nutriments: { "energy-kcal_100g": 100, "sodium_100g": 0.4, "cholesterol_100g": 0.05 },
  }] })))
  const result = await estimateRecipe(recipe("Testfood", "g", 200))
  expect(result.totalNutrients.sodiumPer100g).toBe(800)
  expect(result.perServingNutrients.sodiumPer100g).toBe(400)
  const patch = buildNutritionPatch(result, "units", "2 servings")
  expect(patch.nutrition.sodiumContent).toBe("400")
  expect(patch.nutrition.cholesterolContent).toBe("50")
})
