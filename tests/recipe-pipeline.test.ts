import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { config } from "../src/config.js"
import type { MealieIngredient, MealieRecipe, NutrientSet } from "../src/types.js"
import { ingredientText, normalizeRecipe, normalizedContext, normalizedGrams, validateNormalizedIngredient, type NormalizedIngredient } from "../src/services/recipe-normalizer.js"
import { estimateRecipe, buildNutritionPatch } from "../src/services/estimator.js"
import { estimateAndTag, tagsAreComplete } from "../src/services/tagging.js"
import { patchRecipe, getOrCreateTags } from "../src/services/mealie-client.js"
import { defaultProviders, resolveNutrition, type NutritionProvider } from "../src/services/nutrition-providers.js"
import { contextForName } from "../src/services/ingredient-context.js"
import { clearLlmCache, initCache, flushCache, getCachedResolvedFood, setCachedResolvedFood } from "../src/utils/cache.js"
import { convertToGrams } from "../src/services/unit-converter.js"
import { readFileSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import initSqlJs from "sql.js"

vi.mock("../src/utils/rate-limiter.js", () => ({ waitForRateLimit: vi.fn(async () => {}), RateLimitType: { Llm: "llm", Search: "search" } }))
vi.mock("../src/services/mealie-client.js", () => ({ patchRecipe: vi.fn(async () => {}), getOrCreateTags: vi.fn(async () => []) }))
const directory = mkdtempSync(join(tmpdir(), "recipe-pipeline-"))
const originalConfig = { llm: { ...config.llm }, estimate: { ...config.estimate }, cache: { ...config.cache }, off: { ...config.openFoodFacts } }
function ingredient(name: string, quantity: number | null = 100, unit = "g"): MealieIngredient {
  return { food: { id: "", name, aliases: [], pluralName: null }, quantity,
    unit: { id: "", name: unit, abbreviation: null, pluralName: null, standardQuantity: null, standardUnit: null },
    originalText: `${quantity ?? "eine"} ${unit} ${name}`, note: null, display: "", title: null }
}
function recipe(ingredients = [ingredient("Reis", 600)]): MealieRecipe {
  return { slug: "pipeline", name: "Pipeline", recipeIngredient: ingredients, recipeYield: "8 servings", recipeServings: null, nutrition: null, extras: {}, tags: [] }
}
function row(ing: MealieIngredient, index = 0, overrides: Partial<NormalizedIngredient> = {}): NormalizedIngredient {
  return { index, original: ingredientText(ing), name: "rice", searchName: "rice dry", amount: ing.quantity || 1, unit: "g", estimatedAmount: false,
    state: "dry", generic: true, brand: null, category: "grain", confidence: 0.95, ...overrides }
}
function completion(value: unknown): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }))
}
const profile: NutrientSet = { kcalPer100g: 400, proteinPer100g: 20, carbsPer100g: 35, fatPer100g: 20,
  fiberPer100g: null, sodiumPer100g: 100, sugarPer100g: null, saturatedFatPer100g: null, transFatPer100g: null, unsaturatedFatPer100g: null, cholesterolPer100g: null }
beforeAll(async () => { config.cache.dbPath = join(directory, "cache.db"); await initCache() })
beforeEach(() => {
  clearLlmCache()
  Object.assign(config.llm, { enabled: true, normalizeRecipe: true, apiKey: "test-only", model: "fixture-model" })
  config.estimate.autoTags = false
  config.openFoodFacts.maxRetries = 0
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected request"))
})
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks() })

describe("whole-recipe JSON normalization", () => {
  it("sends all ingredients once without recipeYield, then reuses the validated normalization", async () => {
    const input = recipe([ingredient("Reis", 300), ingredient("Parmesan", 50)])
    vi.mocked(fetch).mockResolvedValue(completion({ ingredients: [row(input.recipeIngredient[0]), row(input.recipeIngredient[1], 1, { name: "parmesan", searchName: "parmesan", state: "unspecified", category: "dairy" })] }))
    expect((await normalizeRecipe(input))?.length).toBe(2)
    input.recipeYield = "16 servings"
    await normalizeRecipe(input)
    expect(fetch).toHaveBeenCalledOnce()
    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body))
    expect(body.model).toBe("fixture-model")
    expect(body.response_format).toEqual({ type: "json_object" })
    const request = JSON.parse(body.messages[1].content)
    expect(request.ingredients).toHaveLength(2)
    expect(request.recipeYield).toBeUndefined()
    expect(request.recipeServings).toBeUndefined()
  })
  it.each([{ amount: -1 }, { amount: "100" }, { unit: "servings" }, { confidence: 2 }, { estimatedAmount: "true" }, { index: 1 }, { calories: 900 }, { amount: Infinity }])("rejects invalid normalized fields %j", override => {
    expect(validateNormalizedIngredient({ ...row(ingredient("Reis")), ...override }, 0)).toBe(false)
  })
  it("rejects arbitrary prose, omitted ingredients and reordered indexes", async () => {
    const input = recipe()
    for (const value of ["write calories=999", { ingredients: [] }, { ingredients: [row(input.recipeIngredient[0], 1)] }]) {
      vi.mocked(fetch).mockResolvedValue(completion(value))
      expect((await normalizeRecipe(input))?.filter(Boolean).length ?? 0).toBe(0)
    }
  })
  it("validates rows independently so one invalid row cannot discard valid neighbors", async () => {
    const input = recipe([ingredient("Reis"), ingredient("???")])
    vi.mocked(fetch).mockResolvedValue(completion({ ingredients: [row(input.recipeIngredient[0]), { invalid: true }] }))
    expect(await normalizeRecipe(input)).toEqual([row(input.recipeIngredient[0]), null])
  })
  it("rejects lost light qualifiers, invented brands and conflicting food states", () => {
    expect(normalizedContext(row(ingredient("Mayo Light"), 0, { name: "mayonnaise" }), ingredient("Mayo Light"))).toBeNull()
    expect(normalizedContext(row(ingredient("Reis"), 0, { generic: false, brand: "Invented" }), ingredient("Reis"))).toBeNull()
    expect(normalizedContext(row(ingredient("Reis gekocht")), ingredient("Reis gekocht"))).toBeNull()
  })
  it("normalizes unparsed German ingredient text into an internal weight", async () => {
    const ing = { ...ingredient("", null), food: null, quantity: null, unit: null, originalText: "2 rote Zwiebeln" }
    vi.mocked(fetch).mockResolvedValue(completion({ ingredients: [row(ing, 0, { name: "red onion", searchName: "red onion", state: "raw", category: "vegetable", amount: 220, estimatedAmount: true })] }))
    const result = await estimateRecipe(recipe([ing]))
    expect(result.matchedIngredients[0]).toMatchObject({ grams: 220, estimatedAmount: true, source: "generic" })
    expect(result.warnings).toContain("Quantity estimated: 2 rote Zwiebeln")
    expect(ing.quantity).toBeNull()
  })
})

describe("deterministic quantities and nutrition", () => {
  it.each([["g", 300, 300], ["kg", 0.3, 300], ["mg", 300000, 300]])("preserves structured %s mass even when the LLM divides by 8", (unit, amount, grams) => {
    const ing = ingredient("Reis", amount, unit)
    expect(normalizedGrams(row(ing, 0, { amount: 8 }), ing)).toEqual({ grams, estimated: false })
  })
  it("preserves explicit grams in unparsed text even when the model changes the quantity", () => {
    const ing = { ...ingredient("", null), food: null, unit: null, originalText: "300 g Nudeln" }
    expect(normalizedGrams(row(ing, 0, { amount: 8 }), ing)).toEqual({ grams: 300, estimated: false })
  })
  it.each([["EL", "olive oil", 13.5], ["Esslöffel", "olive oil", 13.5], ["TL", "salt", 6], ["Teelöffel", "salt", 6], ["Prise", "salt", 0.25], ["Stück", "onion", 110]])("converts German %s with food-specific measures", (unit, name, grams) => {
    expect(convertToGrams(1, ingredient(name, 1, unit).unit, contextForName(name))).toBeCloseTo(grams)
  })
  it("8 servings stays a divisor: 600 g × 400 kcal/100 g = 2400 total and 300 per serving", async () => {
    const input = recipe([ingredient("Fixture food", 600)])
    const original = structuredClone(input)
    vi.mocked(fetch).mockImplementation(async (_url, options) => {
      const body = options?.body ? JSON.parse(String(options.body)) : null
      if (body?.response_format) return completion({ ingredients: [row(input.recipeIngredient[0], 0, { name: "fixture food", searchName: "fixture food", state: "unspecified", generic: false, category: "other", amount: 8 })] })
      return new Response(JSON.stringify({ hits: [{ product_name: "fixture food", nutriments: { "energy-kcal_100g": 400, "proteins_100g": 20, "carbohydrates_100g": 35, "fat_100g": 20, "sodium_100g": 0.1 } }] }))
    })
    const result = await estimateRecipe(input)
    expect(input).toEqual(original)
    expect(result.matchedIngredients[0].grams).toBe(600)
    expect(result.totals).toMatchObject({ kcal: 2400, proteinG: 120, carbsG: 210, fatG: 120, sodiumMg: 600, fiberG: null })
    expect(result.perServing).toMatchObject({ kcal: 300, proteinG: 15, carbsG: 26.25, fatG: 15, sodiumMg: 75 })
    const patch = buildNutritionPatch(result, "hash", input.recipeYield)
    expect(patch.nutrition).toMatchObject({ calories: "300", proteinContent: "15", carbohydrateContent: "26.25", fatContent: "15", sodiumContent: "75" })
    expect(patch.nutrition.fiberContent).toBeUndefined()
    await estimateAndTag(input, "hash")
    expect(patchRecipe).toHaveBeenCalledWith("pipeline", expect.objectContaining({ nutrition: patch.nutrition }), undefined)
    const sent = vi.mocked(patchRecipe).mock.calls[0][1]
    expect(Object.keys(sent).sort()).toEqual(["extras", "nutrition"])
    expect(getOrCreateTags).not.toHaveBeenCalled()
    expect(tagsAreComplete(input)).toBe(true)
  })
  it("continues calculation and reports an invalid ingredient without changing Mealie text", async () => {
    const input = recipe([ingredient("Reis"), ingredient("???", null)])
    const before = structuredClone(input)
    vi.mocked(fetch).mockResolvedValue(completion({ ingredients: [row(input.recipeIngredient[0]), null] }))
    const result = await estimateRecipe(input)
    expect(result.matchedCount).toBe(1)
    expect(result.unmatchedCount).toBe(1)
    expect(result.totals?.kcal).toBe(365)
    expect(input).toEqual(before)
  })
  it("does not block a low-confidence seasoning with a valid profile and quantity", async () => {
    const ing = ingredient("Pfeffer", null, "Prise")
    vi.mocked(fetch).mockResolvedValue(completion({ ingredients: [row(ing, 0, { name: "black pepper", searchName: "black pepper", state: "unspecified", category: "spice", amount: 0.25, estimatedAmount: true, confidence: 0.5 })] }))
    const result = await estimateRecipe(recipe([ing]))
    expect(result.matchedCount).toBe(1)
    expect(result.partial).toBe(false)
    expect(result.matchedIngredients[0].finalMatchConfidence).toBe(0.5)
  })
})

describe("provider priority and persistent cache", () => {
  it("orders cache, OFF, existing USDA and final LLM providers", () => {
    expect(defaultProviders().map(p => p.name)).toEqual(["local-cache", "openfoodfacts", "generic-food-database", "llm-estimate"])
  })
  it("resolves a cache miss and then reuses the profile with its original confidence", async () => {
    const context = { ...contextForName("rice dry"), generic: true }
    const first = await resolveNutrition(context)
    expect(first?.source).toBe("generic")
    const second = await resolveNutrition(context)
    expect(second).toMatchObject({ source: "local-cache", originalSource: "generic", confidence: first?.confidence, nutrients: first?.nutrients })
    expect(fetch).not.toHaveBeenCalled()
  })
  it("OFF failure reaches LLM fallback and caches the estimate without inflating confidence", async () => {
    vi.mocked(fetch).mockImplementation(async (_url, options) => options?.method === "POST"
      ? completion({ kcal: 400, protein: 20, carbs: 35, fat: 20, saturatedFat: null, transFat: null, fiber: null, sugar: null, sodium: 100, cholesterol: null })
      : new Response("unavailable", { status: 503 }))
    const context = { ...contextForName("fallback fixture food"), generic: false }
    expect(await resolveNutrition(context)).toMatchObject({ source: "LLM", confidence: 0.6 })
    const calls = vi.mocked(fetch).mock.calls.length
    expect(await resolveNutrition(context)).toMatchObject({ source: "local-cache", originalSource: "LLM", confidence: 0.6 })
    expect(fetch).toHaveBeenCalledTimes(calls)
  })
  it("contains provider exceptions and rejects invalid profiles before trying the next source", async () => {
    const good = { nutrients: profile, source: "generic" as const, confidence: 0.9, timestamp: Date.now(), productName: null, reason: "fixture" }
    const providers: NutritionProvider[] = [
      { name: "broken", resolve: async () => { throw new Error("offline") } },
      { name: "invalid", resolve: async () => ({ ...good, nutrients: { ...profile, kcalPer100g: -5 } }) },
      { name: "fixture", resolve: async () => good },
    ]
    expect(await resolveNutrition(contextForName("fixture"), providers)).toEqual(good)
  })
  it("writes nutrition, aliases, provenance and timestamps into a reopenable SQLite file", async () => {
    expect(getCachedResolvedFood("persist-fixture")).toBeUndefined()
    const value = { normalizedName: "fixture food", aliases: ["test food"], nutrients: profile, source: "LLM" as const, confidence: 0.6, timestamp: Date.now(), productName: null }
    setCachedResolvedFood("persist-fixture", value)
    flushCache()
    const SQL = await initSqlJs()
    const reopened = new SQL.Database(readFileSync(config.cache.dbPath))
    const data = reopened.exec("SELECT food FROM resolved_food_cache WHERE lookup_key='persist-fixture'")
    expect(JSON.parse(String(data[0].values[0][0]))).toEqual(value)
    reopened.close()
  })
})

afterAll(() => { flushCache(); Object.assign(config.llm, originalConfig.llm); Object.assign(config.estimate, originalConfig.estimate); Object.assign(config.openFoodFacts, originalConfig.off); Object.assign(config.cache, originalConfig.cache); rmSync(directory, { recursive: true, force: true }) })
