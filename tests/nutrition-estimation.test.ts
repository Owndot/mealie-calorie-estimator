import { contextForName, nutrientCacheKey } from "../src/services/ingredient-context.js"
import { genericNutrients } from "../src/services/generic-foods.js"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { estimateRecipe, buildNutritionPatch } from "../src/services/estimator.js"
import { lookupNutrients } from "../src/services/off-client.js"
import { estimateGrams, estimateNutrients } from "../src/services/llm-estimator.js"
import { getCachedOffLookup, setCachedOffLookup } from "../src/utils/cache.js"
import type { MealieRecipe, NutrientSet } from "../src/types.js"

vi.mock("../src/utils/cache.js", () => ({
  getCachedOffLookup: vi.fn(), setCachedOffLookup: vi.fn(),
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
  ])("rejects %s -> %s before selecting a fallback", async (food, product) => {
    offResponse(product)
    expect((await lookupNutrients(food)).matched).toBe(false)
    expect(setCachedOffLookup).not.toHaveBeenCalled()
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
    const kcal = genericNutrients(contextForName(food))?.kcalPer100g ?? 10
    offResponse(product, kcal)
    const result = await lookupNutrients(food)
    expect(result.matched).toBe(true)
    expect(result.nutrients?.kcalPer100g).toBe(kcal)
    expect(estimateNutrients).not.toHaveBeenCalled()
    expect(setCachedOffLookup).toHaveBeenCalledOnce()
  })

  it("leaves a rejected match unmatched if LLM is unavailable", async () => {
    offResponse("smalec")
    vi.mocked(estimateNutrients).mockResolvedValue(null)
    const result = await estimateRecipe(recipe("UnknownFood"))
    expect(result.unmatchedIngredients).toEqual(["UnknownFood"])
    expect(result.totalNutrients.kcalPer100g).toBeNull()
  })

  it("bypasses legacy cache entries", async () => {
    vi.mocked(getCachedOffLookup).mockImplementation(key => key === "Zwiebel" ? { nutrients: salt, productName: "smalec", confidence: "high" as const } : undefined)
    offResponse("smalec")
    expect((await lookupNutrients("Zwiebel")).matched).toBe(false)
    expect(getCachedOffLookup).toHaveBeenCalledWith(nutrientCacheKey("off", contextForName("Zwiebel")))
  })

  it("validates the food after removing the unit prefix", async () => {
    offResponse("Salz", 0, 39.3)
    expect((await lookupNutrients("Prise Salz", "Prise")).matched).toBe(true)
  })
})

describe("zero kcal salt", () => {
  it.each(["off", "llm"])("uses deterministic Prise Salz regardless of %s availability", async source => {
    offResponse(source === "off" ? "Salz" : "unrelated product", 0, 39.3)
    vi.mocked(estimateNutrients).mockResolvedValue(salt)
    const result = await estimateRecipe(recipe("Salz", "Prise", 1))
    expect(estimateGrams).not.toHaveBeenCalled()
    expect(result.matchedCount).toBe(1)
    expect(result.matchedIngredients[0].grams).toBe(0.25)
    expect(result.totalNutrients.kcalPer100g).toBe(0)
    expect(result.totalNutrients.sodiumPer100g).toBeCloseTo(98.25)
    expect(result.perServingNutrients.sodiumPer100g).toBe(49.125)
    const patch = buildNutritionPatch(result, "test-hash", "2 servings")
    expect(patch.nutrition.calories).toBe("0")
    expect(patch.nutrition.sodiumContent).toBe("49")
  })
})

describe("German recipe units", () => {
  it.each([
    ["TL", "Kreuzkümmel", 2.1], ["Teelöffel", "Currypulver", 2],
    ["EL", "Kokosöl", 13.6], ["Esslöffel", "Tomatenmark", 16],
    ["Prise", "Salz", 0.25], ["tl.", "Kreuzkümmel", 2.1],
    ["TEEL.", "Currypulver", 2], ["el.", "Kokosöl", 13.6],
    ["ESSL.", "Tomatenmark", 16], ["PRISE.", "Salz", 0.25],
    ["Gramm", "Salz", 1], ["Kilogramm", "Tomatenmark", 1000],
    ["Milliliter", "Kokosöl", 0.9], ["Liter", "Kokosöl", 900],
  ])("converts 1 %s %s without asking the LLM for grams", async (unitName, foodName, grams) => {
    offResponse(foodName, genericNutrients(contextForName(foodName))?.kcalPer100g ?? 10)
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
    expect(estimateGrams).toHaveBeenCalledExactlyOnceWith(2, "piece", "eggplant raw")
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
