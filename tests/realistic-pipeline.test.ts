import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import fixtures from "./fixtures/realistic-german-recipes.json"
import { config } from "../src/config.js"
import { initCache, clearLlmCache, flushCache } from "../src/utils/cache.js"
import { estimateRecipe, buildNutritionPatch } from "../src/services/estimator.js"
import { estimateAndTag } from "../src/services/tagging.js"
import { patchRecipe } from "../src/services/mealie-client.js"
import { normalizedGrams, type NormalizedIngredient } from "../src/services/recipe-normalizer.js"
import { defaultProviders } from "../src/services/nutrition-providers.js"
import type { MealieRecipe, MealieIngredient, EstimateResult } from "../src/types.js"

vi.mock("../src/utils/rate-limiter.js", () => ({ waitForRateLimit: vi.fn(async () => {}), RateLimitType: { Llm: "llm", Search: "search" } }))
vi.mock("../src/services/mealie-client.js", () => ({ patchRecipe: vi.fn(async () => {}), getOrCreateTags: vi.fn(async () => []) }))
const directory = mkdtempSync(join(tmpdir(), "realistic-nutrition-"))
const reports: Record<string, unknown> = {}
const calls = { normalization: 0, classification: 0, weight: 0, nutrients: 0, off: 0 }
type Food = [string, string, number | null, string | null, string, string, number, number, number, number, number]
function makeRecipe(key: keyof typeof fixtures): { recipe: MealieRecipe; rows: NormalizedIngredient[]; foods: Food[] } {
  const foods = fixtures[key].foods as Food[]
  const ingredients: MealieIngredient[] = foods.map(([text, name, quantity, unit]) => ({ quantity,
    food: { id: name, name, pluralName: null, aliases: [] },
    unit: unit ? { id: unit, name: unit, abbreviation: unit, pluralName: null, standardQuantity: null, standardUnit: null } : null,
    originalText: text, display: text, note: null, title: null }))
  const rows: NormalizedIngredient[] = foods.map(([text, , , unit, name, state, grams], index) => ({
    index, original: text, name, searchName: `${name} ${state}`, state: state as NormalizedIngredient["state"], amount: grams, unit: "g",
    estimatedAmount: unit !== "g", generic: true, brand: null, category: ["salt", "black pepper", "thyme", "paprika", "garlic powder"].includes(name) ? "spice" : "other", confidence: unit === "g" ? 0.95 : 0.65 }))
  return { foods, rows, recipe: { slug: `recipe-${key}`, name: `Realistic recipe ${key}`, recipeYield: `${fixtures[key].servings} servings`, recipeServings: null,
    recipeIngredient: ingredients, recipeInstructions: [{ text: "Zutaten wie angegeben vorbereiten, dann garen und servieren." }],
    nutrition: null, extras: { user_note: "Keep this" }, tags: [{ id: "user", name: "User tag", slug: "user-tag", groupId: null }] } }
}
const completion = (value: unknown) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }))
function serve(rows: NormalizedIngredient[], foods: Food[], offHits: unknown[] = []) {
  vi.mocked(fetch).mockImplementation(async (_url, options) => {
    if (options?.method !== "POST") { calls.off++; return new Response(JSON.stringify({ hits: offHits })) }
    const body = JSON.parse(String(options.body))
    if (body.response_format) {
      calls.normalization++
      expect(body.response_format).toEqual({ type: "json_object" })
      const input = JSON.parse(body.messages[1].content)
      expect(input.ingredients).toHaveLength(rows.length)
      expect(input).not.toHaveProperty("recipeYield")
      expect(input).not.toHaveProperty("recipeServings")
      expect(body.messages[0].content).toContain("Do not return nutrients or recipe totals")
      return completion({ ingredients: rows })
    }
    const prompt = body.messages.map((m: { content: string }) => m.content).join(" ")
    if (prompt.includes("Estimate nutrition for 100 g")) {
      calls.nutrients++
      const food = foods.find(f => prompt.includes(`"${f[4]} ${f[5]}`))
      if (!food) throw Error(`Missing profile fixture: ${prompt}`)
      return completion({ kcal: food[7], protein: food[8], carbs: food[9], fat: food[10], fiber: null, sodium: null, sugar: null, saturatedFat: null, transFat: null, cholesterol: null })
    }
    if (prompt.includes("Estimate the weight")) calls.weight++
    else calls.classification++
    return completion(null)
  })
}
function assertArithmetic(result: EstimateResult, foods: Food[], servings: number) {
  const expected = [7, 8, 9, 10].map(column => foods.reduce((sum, food) => sum + Number(food[column]) * food[6] / 100, 0))
  for (const [index, field] of (["kcal", "proteinG", "carbsG", "fatG"] as const).entries()) {
    expect(result.totals?.[field]).toBeCloseTo(expected[index], 5)
    expect(result.perServing?.[field]).toBeCloseTo(expected[index] / servings, 5)
  }
}
beforeAll(async () => { config.cache.dbPath = join(directory, "cache.db"); await initCache() })
beforeEach(() => {
  clearLlmCache()
  Object.assign(config.llm, { enabled: true, normalizeRecipe: true, apiKey: "fixture-only", model: "realistic-fixture" })
  config.estimate.autoTags = false
  config.estimate.partialPolicy = "withhold"
  config.openFoodFacts.maxRetries = 0
  Object.keys(calls).forEach(key => calls[key as keyof typeof calls] = 0)
  vi.restoreAllMocks(); vi.clearAllMocks()
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network call"))
})

it.each(["A", "B", "C"] as const)("realistic recipe %s: exact mass, deterministic totals, one batch and untouched Mealie content", async key => {
  const { recipe, rows, foods } = makeRecipe(key)
  const before = structuredClone(recipe)
  serve(rows, foods)
  const result = await estimateRecipe(recipe)
  expect(result.partial).toBe(false)
  expect(result.matchedCount).toBe(foods.length)
  expect(result.servings).toBe(fixtures[key].servings)
  expect(result.matchedIngredients.map(i => i.grams)).toEqual(foods.map(f => f[6]))
  expect(result.matchedIngredients.map(i => i.estimatedAmount)).toEqual(rows.map(r => r.estimatedAmount))
  assertArithmetic(result, foods, fixtures[key].servings)
  expect(calls.normalization).toBe(1)
  expect(calls.classification).toBe(0)
  expect(recipe).toEqual(before)
  for (const matched of result.matchedIngredients) {
    expect(matched.source).toBeTruthy()
    expect(matched.sourceConfidence).toBeGreaterThan(0)
    expect(matched.finalMatchConfidence).toBeGreaterThan(0)
  }
  if (key === "A") {
    const seasoningKcal = result.matchedIngredients.slice(10).reduce((sum, i) => sum + i.grams! * i.nutrients!.kcalPer100g! / 100, 0)
    expect(seasoningKcal).toBeLessThan(15)
  }
  const cold = { ...calls }
  await estimateAndTag(recipe, `validation-${key}`)
  expect(calls).toEqual(cold)
  const patch = vi.mocked(patchRecipe).mock.calls[0][1]
  expect(Object.keys(patch).sort()).toEqual(["extras", "nutrition"])
  const after = { ...recipe, ...patch }
  for (const field of ["recipeIngredient", "recipeYield", "recipeInstructions", "name", "tags"] as const) expect(after[field]).toEqual(before[field])
  expect(patch.extras?.user_note).toBe("Keep this")
  expect(patch.nutrition).toEqual(buildNutritionPatch(result, `validation-${key}`, recipe.recipeYield, null).nutrition)
  reports[key] = { before, patch, after, coldRequests: cold, totals: result.totals, perServing: result.perServing,
    ingredients: result.matchedIngredients.map(({ name, grams, estimatedAmount, source, sourceConfidence, finalMatchConfidence }) => ({ name, grams, estimatedAmount, source, sourceConfidence, finalMatchConfidence })) }
})

it.each([8, 1 / 8])("recipe B refuses model mass scaling by %s", async factor => {
  const { recipe, rows, foods } = makeRecipe("B")
  rows.forEach(row => row.amount *= factor)
  serve(rows, foods)
  const result = await estimateRecipe(recipe)
  expect(result.matchedIngredients.map(i => i.grams)).toEqual([600, 800, 200, 30])
  assertArithmetic(result, foods, 8)
})

it("an unresolved minor seasoning returns a partial result without throwing or rewriting recipe content", async () => {
  const { recipe, rows, foods } = makeRecipe("C")
  rows[3] = null as unknown as NormalizedIngredient
  recipe.recipeIngredient[3] = { ...recipe.recipeIngredient[3], food: { id: "", name: "Unbekanntes Gewürz", aliases: [], pluralName: null } }
  serve(rows, foods)
  const result = await estimateRecipe(recipe)
  expect(result.matchedCount).toBe(6)
  expect(result.unmatchedCount).toBe(1)
  expect(result.totals?.kcal).toBeGreaterThan(300)
  expect(buildNutritionPatch(result, "partial", recipe.recipeYield, null).nutrition).toEqual({})
  expect(calls.classification).toBe(0)
})

it("explicit Mealie standard mass overrides the model's can estimate", () => {
  const { recipe, rows } = makeRecipe("C")
  recipe.recipeIngredient[5].unit!.standardQuantity = 400
  recipe.recipeIngredient[5].unit!.standardUnit = "g"
  rows[5].amount = 800
  expect(normalizedGrams(rows[5], recipe.recipeIngredient[5])).toEqual({ grams: 400, estimated: false })
})

it("malformed whole-recipe JSON never fans out into per-ingredient classification requests", async () => {
  const { recipe } = makeRecipe("B")
  recipe.recipeIngredient = Array.from({ length: 15 }, (_, index) => ({ ...recipe.recipeIngredient[0], food: { id: "", name: `Unknown food ${index}`, aliases: [], pluralName: null } }))
  vi.mocked(fetch).mockImplementation(async (_url, options) => {
    if (options?.method !== "POST") { calls.off++; return new Response(JSON.stringify({ hits: [] })) }
    const body = JSON.parse(String(options.body))
    if (body.response_format) { calls.normalization++; return new Response(JSON.stringify({ choices: [{ message: { content: "{bad json" } }] })) }
    if (body.messages[0].content.includes("Estimate nutrition for 100 g")) calls.nutrients++
    else calls.classification++
    return completion(null)
  })
  const result = await estimateRecipe(recipe)
  expect(result.partial).toBe(true)
  expect(calls.normalization).toBe(1)
  expect(calls.classification).toBe(0)
  expect(buildNutritionPatch(result, "invalid", "8 servings", null).nutrition).toEqual({})
})

it("provider sequence is cache, OFF, USDA and LLM in executable code", () => {
  expect(defaultProviders().map(p => p.name)).toEqual(["local-cache", "openfoodfacts", "generic-food-database", "llm-estimate"])
})

afterAll(() => {
  flushCache()
  if (process.env.VALIDATION_OUTPUT_DIR) {
    mkdirSync(process.env.VALIDATION_OUTPUT_DIR, { recursive: true })
    writeFileSync(join(process.env.VALIDATION_OUTPUT_DIR, "realistic-validation.json"), JSON.stringify(reports, null, 2) + "\n")
  }
  rmSync(directory, { recursive: true, force: true })
})

function branded(brand: string) {
  const input = makeRecipe("B")
  input.recipe.recipeIngredient = [{ ...input.recipe.recipeIngredient[0], quantity: 100,
    food: { id: brand, name: `${brand} ketchup`, aliases: [], pluralName: null }, originalText: `100 g ${brand} ketchup`, display: `100 g ${brand} ketchup` }]
  const row: NormalizedIngredient = { ...input.rows[0], original: `100 g ${brand} ketchup`, name: "ketchup", searchName: `${brand} ketchup`,
    amount: 100, state: "unspecified", generic: false, brand, category: "sauce" }
  return { recipe: input.recipe, rows: [row] }
}
function offProduct(name: string, brand: string, kcal: number, complete = false) {
  return { product_name: name, brands: brand, categories_tags: ["en:sauces"], nutriments: {
    "energy-kcal_100g": kcal, "proteins_100g": 1, "carbohydrates_100g": 24, "fat_100g": 0.2,
    ...(complete ? { "fiber_100g": 0.3, "sodium_100g": 0.9, "sugars_100g": 20, "saturated-fat_100g": 0.1, "trans-fat_100g": 0, "cholesterol_100g": 0 } : {}),
  } }
}
it("recipe D/E: rejects arbitrary/wrong-brand/incomplete OFF candidates, ranks completeness and reuses SQLite provenance", async () => {
  const { recipe, rows } = branded("Heinz")
  const incomplete = offProduct("Heinz ketchup", "Heinz", 99)
  delete (incomplete.nutriments as Record<string, unknown>)["proteins_100g"]
  serve(rows, [], [offProduct("Heinz mayonnaise", "Heinz", 101, true), offProduct("Other ketchup", "Other", 101, true), incomplete,
    offProduct("Heinz ketchup", "Heinz", 100), offProduct("Heinz ketchup", "Heinz", 102, true)])
  const first = await estimateRecipe(recipe)
  expect(first.matchedIngredients[0]).toMatchObject({ source: "OFF", productName: "Heinz ketchup", nutrients: { kcalPer100g: 102, sodiumPer100g: 900 } })
  expect(calls).toEqual({ normalization: 1, off: 1, classification: 0, weight: 0, nutrients: 0 })
  const second = await estimateRecipe(recipe)
  expect(second.matchedIngredients[0]).toMatchObject({ source: "local-cache", originalSource: "OFF", sourceConfidence: first.matchedIngredients[0].sourceConfidence })
  expect(second.matchedIngredients[0].nutrients).toEqual(first.matchedIngredients[0].nutrients)
  expect(second.totals).toEqual(first.totals)
  expect(calls).toEqual({ normalization: 1, off: 1, classification: 0, weight: 0, nutrients: 0 })
  reports.DE = { cold: first.matchedIngredients, warm: second.matchedIngredients, totalRequestsAcrossBothRuns: { ...calls } }
})
it.each(["outage", "incorrect-candidates"])("recipe D: OFF %s falls back cleanly", async scenario => {
  const { recipe, rows } = branded(`Fixture ${scenario}`)
  vi.mocked(fetch).mockImplementation(async (_url, options) => {
    if (options?.method !== "POST") { calls.off++; return scenario === "outage" ? new Response("offline", { status: 503 }) : new Response(JSON.stringify({ hits: [offProduct("Unrelated mayonnaise", "Wrong brand", 102, true)] })) }
    const body = JSON.parse(String(options.body))
    if (body.response_format) { calls.normalization++; return completion({ ingredients: rows }) }
    calls.nutrients++
    return completion({ kcal: 102, protein: 1, carbs: 24, fat: 0.2, fiber: 0.3, sodium: 900 })
  })
  const result = await estimateRecipe(recipe)
  expect(result.partial).toBe(false)
  expect(result.matchedIngredients[0]).toMatchObject({ source: "LLM", sourceConfidence: 0.6 })
  expect(calls).toEqual({ normalization: 1, off: 1, nutrients: 1, weight: 0, classification: 0 })
})
it("15-ingredient cold/warm counts include OFF retries and the bounded LLM nutrient corrective retry", async () => {
  const input = makeRecipe("B")
  input.recipe.recipeIngredient = Array.from({ length: 15 }, (_, i) => ({ ...input.recipe.recipeIngredient[0], quantity: 100,
    food: { id: "", name: `FixtureBrand product ${i} 2%`, aliases: [], pluralName: null }, originalText: `100 g FixtureBrand product ${i} 2%`, display: "" }))
  const rows = input.recipe.recipeIngredient.map((ing, index) => ({ ...input.rows[0], index, original: ing.originalText!, name: `product ${index} 2%`,
    searchName: `FixtureBrand product ${index} 2%`, generic: false, brand: "FixtureBrand", state: "unspecified", amount: 100 }))
  config.openFoodFacts.maxRetries = 3
  config.openFoodFacts.retryBackoffMs = 0
  vi.mocked(fetch).mockImplementation(async (_url, options) => {
    if (options?.method !== "POST") { calls.off++; return new Response("offline", { status: 503 }) }
    const body = JSON.parse(String(options.body))
    if (body.response_format) { calls.normalization++; return completion({ ingredients: rows }) }
    calls.nutrients++
    const retry = body.messages[0].content.includes("Correct the previous estimate")
    return completion({ kcal: retry ? 100 : 170, protein: 10, carbs: 10, fat: retry ? 2 : 10 })
  })
  const first = await estimateRecipe(input.recipe)
  expect(first.matchedCount).toBe(15)
  expect(calls).toEqual({ normalization: 1, off: 60, nutrients: 30, weight: 0, classification: 0 })
  const second = await estimateRecipe(input.recipe)
  expect(second.matchedIngredients.every(i => i.source === "local-cache" && i.originalSource === "LLM")).toBe(true)
  expect(second.totals).toEqual(first.totals)
  expect(calls).toEqual({ normalization: 1, off: 60, nutrients: 30, weight: 0, classification: 0 })
  reports.requestCounts15 = { cold: { ...calls }, warmAdditional: { normalization: 0, off: 0, nutrients: 0, classification: 0, weight: 0 } }
})

it("omits incomplete optional nutrient totals instead of writing a known subtotal as zero", async () => {
  const { recipe, rows, foods } = makeRecipe("B")
  serve(rows, foods)
  const result = await estimateRecipe(recipe)
  expect(result.totals?.fiberG).toBeNull()
  expect(result.totals?.sodiumMg).toBeNull()
  const patch = buildNutritionPatch(result, "unknown-nutrients", recipe.recipeYield, null)
  expect(patch.nutrition).not.toHaveProperty("fiberContent")
  expect(patch.nutrition).not.toHaveProperty("sodiumContent")
  expect(patch.nutrition.calories).toBe("436")
  expect(result.warnings?.some(warning => warning.includes("Unknown recipe nutrients omitted"))).toBe(true)
})
