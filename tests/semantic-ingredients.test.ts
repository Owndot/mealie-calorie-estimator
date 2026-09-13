import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import fixtures from "./fixtures/german-ingredients.json"
import { config } from "../src/config.js"
import { initCache, clearLlmCache } from "../src/utils/cache.js"
import { interpretSemanticIngredient, validateInterpretation } from "../src/services/ingredient-interpreter.js"
import { contextForName } from "../src/services/ingredient-context.js"
import { genericCatalog, genericNutrients, matchGenericFood } from "../src/services/generic-foods.js"
import { validateProfile } from "../src/services/nutrition-validation.js"
import { estimateRecipe, buildNutritionPatch } from "../src/services/estimator.js"
import type { MealieIngredient, MealieRecipe } from "../src/types.js"

vi.mock("../src/utils/rate-limiter.js", () => ({ waitForRateLimit: vi.fn(async () => {}), RateLimitType: { Llm: "llm", Search: "search" } }))
const original = { ...config.llm }
function ingredient(name: string): MealieIngredient {
  return { quantity: 100, unit: { id: "g", name: "g", abbreviation: null, pluralName: null, standardQuantity: null, standardUnit: null },
    food: { id: "", name, pluralName: null, aliases: [] }, note: null, display: name, title: null, originalText: null }
}
function recipe(ing: MealieIngredient): MealieRecipe {
  return { slug: "semantic", name: "Semantic test", recipeIngredient: [ing], recipeServings: 1, recipeYield: "1 Portion", tags: [], extras: {}, nutrition: null }
}
function response(value: unknown) { return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }), { status: 200 }) }
function interpretation(canonicalFood = "coriander seeds", state = "unspecified", extras: Record<string, unknown> = {}) {
  return { canonicalFood, state, category: "spice", generic: true, brand: null, confidence: 0.96, ...extras }
}
beforeAll(initCache)
beforeEach(() => {
  clearLlmCache()
  config.llm.enabled = true; config.llm.apiKey = "test-only"; config.llm.model = "semantic-test"
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected external request"))
})
afterEach(() => { Object.assign(config.llm, original); vi.restoreAllMocks() })

describe("German semantic interpretation pipeline (controlled model responses)", () => {
  it.each(fixtures)("%s selects the %s %s USDA profile", async (name, canonical, state) => {
    const expectedName = canonical === "basmati rice" ? "rice" : canonical
    const entry = genericCatalog.find(x => x.name === expectedName && x.state === state)!
    expect(entry).toBeDefined()
    vi.mocked(fetch).mockResolvedValue(response(interpretation(canonical, state, { category: entry.entry.category })))
    const result = await estimateRecipe(recipe(ingredient(name)))
    expect(result.partial).toBe(false)
    expect(result.matchedIngredients[0]).toMatchObject({ source: "generic", profileId: entry.entry.fdcId,
      context: { generic: true, state }, interpretationConfidence: expect.any(Number), sourceConfidence: expect.any(Number), finalMatchConfidence: expect.any(Number) })
    expect(result.totals?.kcal).toBe(entry.entry.nutrients.kcalPer100g)
    expect(fetch).toHaveBeenCalledTimes(result.matchedIngredients[0].context?.interpretationSource === "LLM" ? 1 : 0)
    for (const [url, request] of vi.mocked(fetch).mock.calls) {
      expect(String(url)).not.toContain("/search?")
      const body = JSON.parse(request!.body as string)
      expect(body.messages[0].content).toContain("Do NOT estimate nutrients")
    }
  })
  it("contains at least 50 distinct German inputs outside the legacy deterministic identities", async () => {
    let classified = 0
    for (const [name, canonical, state] of fixtures) {
      const entry = genericCatalog.find(x => x.name === (canonical === "basmati rice" ? "rice" : canonical) && x.state === state)!
      vi.mocked(fetch).mockResolvedValue(response(interpretation(canonical, state, { category: entry.entry.category })))
      if ((await interpretSemanticIngredient(ingredient(name)))?.interpretationSource === "LLM") classified++
    }
    expect(classified).toBeGreaterThanOrEqual(50)
  })
})

describe("interpretation cache and confidence safety", () => {
  it("reuses classification across quantities and concurrent requests", async () => {
    vi.mocked(fetch).mockImplementation(async () => response(interpretation()))
    const first = ingredient("Korianderkörner")
    const second = { ...first, quantity: 3 }
    await Promise.all([interpretSemanticIngredient(first), interpretSemanticIngredient(second)])
    await interpretSemanticIngredient(second)
    expect(fetch).toHaveBeenCalledOnce()
  })
  it("separates state notes and models", async () => {
    vi.mocked(fetch).mockImplementation(async () => response(interpretation("chickpeas", "dry", { category: "legume" })))
    const ing = ingredient("Kichererbsenkörner")
    await interpretSemanticIngredient(ing)
    ing.note = "trocken"
    await interpretSemanticIngredient(ing)
    config.llm.model = "new-model"
    await interpretSemanticIngredient(ing)
    expect(fetch).toHaveBeenCalledTimes(3)
  })
  it.each([null, interpretation("coriander seeds", "unspecified", { confidence: 0.4 }), interpretation("coriander seeds", "unspecified", { confidence: 1.2 }),
    interpretation("coriander seeds", "unspecified", { generic: "true" }), interpretation("coriander seeds", "unspecified", { kcal: 200 }),
    interpretation("coriander seeds", "invalid"), interpretation("", "raw"), interpretation("coriander seeds", "unspecified", { brand: "invented" }),
  ])("rejects invalid/uncertain interpretation without nutrient calls (%#)", async value => {
    vi.mocked(fetch).mockResolvedValue(response(value))
    const input = recipe(ingredient("Korianderkörner"))
    const result = await estimateRecipe(input)
    expect(result.partial).toBe(true)
    expect(buildNutritionPatch(result, "hash", input.recipeYield, null).nutrition).toEqual({})
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(validateInterpretation(value)).toBe(false)
  })
  it("retries malformed classification once and accepts the valid result", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response("{not-json", { status: 200 }))
      .mockResolvedValueOnce(response(interpretation("cumin", "unspecified")))
    const input = ingredient("cumin seeds")
    input.display = "cumin seeds, preparation"
    const result = await interpretSemanticIngredient(input)
    expect(result).toMatchObject({ canonicalName: "cumin", interpretationSource: "LLM" })
    expect(fetch).toHaveBeenCalledTimes(2)
    const retryBody = JSON.parse(vi.mocked(fetch).mock.calls[1][1]!.body as string)
    expect(retryBody.messages[0].content).toContain("Do NOT estimate nutrients")
    expect(retryBody.messages[1].content).toContain("retryInstructions")
    await interpretSemanticIngredient(input)
    expect(fetch).toHaveBeenCalledTimes(2)
  })
  it("retries low-confidence classification once, then leaves both failures unmatched", async () => {
    vi.mocked(fetch).mockResolvedValue(response(interpretation("cumin", "unspecified", { confidence: 0.4 })))
    expect(await interpretSemanticIngredient(ingredient("unknown herb"))).toBeNull()
    expect(fetch).toHaveBeenCalledTimes(2)
  })
  it("does not retry classification more than once", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("null", { status: 200 }))
    expect(await interpretSemanticIngredient(ingredient("unknown herb"))).toBeNull()
    expect(fetch).toHaveBeenCalledTimes(2)
  })
  it("recovers a unique trusted local profile after both classification attempts fail", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("null", { status: 200 }))
    const input = ingredient("cumin seeds")
    input.display = "cumin seeds, unknown preparation"
    const result = await interpretSemanticIngredient(input)
    expect(result).toMatchObject({ canonicalName: "cumin", interpretationSource: "deterministic", generic: true })
    expect(fetch).toHaveBeenCalledTimes(2)
  })
  it("does not use local recovery for branded or ambiguous identities", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("null", { status: 200 }))
    const branded = ingredient("cumin seeds"); branded.note = "Marke Example"
    expect(await interpretSemanticIngredient(branded)).toBeNull()
    clearLlmCache()
    const ambiguous = ingredient("mint")
    expect(await interpretSemanticIngredient(ambiguous)).toBeNull()
    expect(fetch).toHaveBeenCalledTimes(4)
  })
  it("keeps incompatible preparation states blocked during local recovery", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("null", { status: 200 }))
    const input = ingredient("cumin seeds")
    input.note = "gekocht"
    input.display = "cumin seeds, unknown preparation"
    expect(await interpretSemanticIngredient(input)).toBeNull()
    expect(fetch).toHaveBeenCalledTimes(2)
  })
  it("resolves Minze through a transient retry to a trusted fresh herb profile", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response("malformed", { status: 200 }))
      .mockResolvedValueOnce(response(interpretation("spearmint", "fresh", { category: "herb" })))
    const result = await estimateRecipe(recipe(ingredient("Minze")))
    expect(result.partial).toBe(false)
    expect(result.matchedIngredients[0]).toMatchObject({ source: "generic", profileId: "173475", context: { canonicalName: "spearmint", state: "fresh" } })
    expect(fetch).toHaveBeenCalledTimes(2)
  })
  it("covers the core Anatolian lentil soup identities without a partial estimate", async () => {
    vi.mocked(fetch).mockImplementation(async (_url, options) => {
      const body = JSON.parse(options!.body as string)
      const input = JSON.parse(body.messages[1].content)
      const values: Record<string, unknown> = {
        paprika: interpretation("paprika", "unspecified"),
        lemon: interpretation("lemon", "raw", { category: "fruit" }),
        mint: interpretation("spearmint", "fresh", { category: "herb" }),
        "red lentils": interpretation("red lentils", "dry", { category: "legume" }),
        "olive oil": interpretation("olive oil", "unspecified", { category: "oil" }),
      }
      return response(values[input.name] ?? null)
    })
    const soup = recipe(ingredient("paprika"))
    soup.recipeIngredient = ["paprika", "lemon", "mint", "red lentils", "olive oil"].map(name => ingredient(name))
    const result = await estimateRecipe(soup)
    expect(result.partial).toBe(false)
    expect(result.matchedIngredients.map(item => item.context?.canonicalName)).toEqual(["paprika", "lemon", "spearmint", "red lentils", "olive oil"])
    expect(result.matchedIngredients.every(item => item.source === "generic")).toBe(true)
  })
  it("does not override an explicit canned state with dry nutrition", async () => {
    vi.mocked(fetch).mockResolvedValue(response(interpretation("chickpeas", "dry", { category: "legume" })))
    expect(await interpretSemanticIngredient(ingredient("Kichererbsen aus der Dose"))).toBeNull()
  })
  it("clears interpretation cache together with LLM caches", async () => {
    vi.mocked(fetch).mockImplementation(async () => response(interpretation()))
    await interpretSemanticIngredient(ingredient("Korianderkörner"))
    clearLlmCache()
    await interpretSemanticIngredient(ingredient("Korianderkörner"))
    expect(fetch).toHaveBeenCalledTimes(2)
  })
  it("does not require LLM for existing deterministic identities", async () => {
    await estimateRecipe(recipe(ingredient("Basmati-Reis")))
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe("generic retrieval and source boundaries", () => {
  it.each(genericCatalog)("validates USDA $key", item => {
    expect(validateProfile(item.entry.nutrients)).toEqual([])
    expect(item.entry.fdcId).toMatch(/^\d+$/)
  })
  it.each(["ginger root", "coriander seed", "corinder seeds"])("matches synonyms and limited typos: %s", name => {
    const context = contextForName(name)
    context.state = name.startsWith("ginger") ? "raw" : "unspecified"
    expect(matchGenericFood(context)).not.toBeNull()
  })
  it.each(["coconut drink", "coriander leaves", "cumin oil", "rice flour", "ginger sauce", "almond milk"])("does not drop identity tokens from %s", name => {
    expect(matchGenericFood({ ...contextForName(name), state: "unspecified" })).toBeNull()
  })
  it("keeps dry/cooked/canned/drained chickpea profiles separate", () => {
    const ids = ["dry", "cooked", "canned", "drained"].map(state => matchGenericFood({ ...contextForName("chickpeas"), state: state as "dry" })?.entry.fdcId)
    expect(new Set(ids).size).toBe(4)
    expect(ids).not.toContain(undefined)
    expect(matchGenericFood({ ...contextForName("chickpeas"), state: "frozen" })).toBeNull()
  })
  it.each([
    ["ginger", "fresh", "vegetable", "169231"],
    ["coriander seeds", "unspecified", "spice", "170922"],
    ["cumin", "unspecified", "spice", "170923"],
    ["turmeric", "unspecified", "spice", "172231"],
  ])("treats generic=false as advisory for a trusted local %s profile", (canonicalName, state, category, profileId) => {
    const context = { ...contextForName(canonicalName), state: state as "fresh" | "unspecified", generic: false, brand: null, category }
    expect(matchGenericFood(context)?.entry.fdcId).toBe(profileId)
    expect(genericNutrients(context)?.kcalPer100g).toBeGreaterThan(0)
  })
  it("keeps USDA fiber subtraction to a single normalization step and allows fiber-heavy curry powder", () => {
    const match = genericCatalog.find(item => item.key === "curry powder:unspecified")
    expect(match).toBeDefined()
    const nutrients = match!.entry.nutrients
    expect(nutrients.carbsPer100g).toBeCloseTo(2.63)
    expect(nutrients.fiberPer100g).toBeCloseTo(53.2)
    expect(nutrients.carbsPer100g).toBeLessThan(nutrients.fiberPer100g!)
    expect(nutrients.carbsPer100g + nutrients.fiberPer100g!).toBeCloseTo(55.83, 2)
    expect(validateProfile(nutrients)).toEqual([])
  })
  it("uses OFF for a classified branded packaged product", async () => {
    vi.mocked(fetch).mockImplementation(async url => String(url).includes("/search?")
      ? new Response(JSON.stringify({ hits: [{ product_name: "Kokosmilch", brands: "Aroy D", nutriments: { "energy-kcal_100g": 190, "fat_100g": 18, "proteins_100g": 2, "carbohydrates_100g": 4 } }] }))
      : response(interpretation("coconut milk", "unspecified", { category: "sauce", generic: false, brand: "Aroy D" })))
    const result = await estimateRecipe(recipe(ingredient("Aroy-D Kokosmilch")))
    expect(result.matchedIngredients[0]).toMatchObject({ source: "OFF", context: { generic: false, brand: "Aroy D" } })
    expect(fetch).toHaveBeenCalledTimes(2)
  })
  it("keeps unitless Garam Masala unmatched after successful interpretation", async () => {
    vi.mocked(fetch).mockResolvedValue(response(interpretation("garam masala spice blend")))
    const ing = { ...ingredient("Garam Masala"), unit: null, quantity: 1 }
    const result = await estimateRecipe(recipe(ing))
    expect(result.partial).toBe(true)
    expect(result.matchedIngredients[0]).toMatchObject({ grams: null, reason: "unknown weight" })
    expect(fetch).toHaveBeenCalledOnce()
  })
  it("uses only validated nutrient fallback for a generic blend with an explicit teaspoon", async () => {
    vi.mocked(fetch).mockImplementation(async (_url, options) => {
      const body = JSON.parse(options!.body as string)
      if (body.messages[0].role === "system") return response(interpretation("garam masala spice blend"))
      if (body.max_tokens === 10) return response(2) // JSON number text is the weight API contract.
      expect(body.messages[0].content).toContain("sodium and cholesterol = milligrams")
      return response({ kcal: 300, protein: 12, carbs: 30, fat: 12, fiber: 10, sugar: 2, sodium: 50, cholesterol: 0, saturatedFat: 1, transFat: 0 })
    })
    const ing = ingredient("1 TL Garam Masala")
    ing.quantity = 1; ing.unit!.name = "TL"
    const result = await estimateRecipe(recipe(ing))
    expect(result.matchedIngredients[0]).toMatchObject({ source: "LLM", confidence: "low", grams: 2, sourceConfidence: 0.6, finalMatchConfidence: 0.6 })
    expect(result.partial).toBe(false)
    expect(result.totals?.kcal).toBe(6)
    expect(fetch).toHaveBeenCalledTimes(3)
  })
})

it("classifies a brand in a note before considering the generic database", async () => {
  vi.mocked(fetch).mockResolvedValue(response(interpretation("coconut milk", "unspecified", { category: "sauce", generic: false, brand: "Aroy D" })))
  const ing = ingredient("Kokosmilch"); ing.note = "Marke Aroy D"
  const result = await interpretSemanticIngredient(ing)
  expect(result).toMatchObject({ generic: false, brand: "Aroy D", interpretationSource: "LLM" })
  expect(matchGenericFood(result!)).toBeNull()
  expect(fetch).toHaveBeenCalledOnce()
})

it.each(["light", "gesüßt", "natriumarm", "gesalzen"])("rejects classification that drops the %s qualifier", async qualifier => {
  vi.mocked(fetch).mockResolvedValue(response(interpretation("coconut milk", "unspecified", { category: "sauce" })))
  const ing = ingredient("Kokosmilch"); ing.note = qualifier
  expect(await interpretSemanticIngredient(ing)).toBeNull()
})

it("refuses a different OFF brand after semantic classification", async () => {
  vi.mocked(fetch).mockImplementation(async (url, options) => {
    if (String(url).includes("/search?")) return new Response(JSON.stringify({ hits: [{ product_name: "Kokosmilch", brands: "Other Brand", nutriments: { "energy-kcal_100g": 190 } }] }))
    const body = JSON.parse(options!.body as string)
    return body.messages[0].role === "system" ? response(interpretation("coconut milk", "unspecified", { category: "sauce", generic: false, brand: "Test Brand" })) : response(null)
  })
  const result = await estimateRecipe(recipe(ingredient("Test Brand Kokosmilch")))
  expect(result.partial).toBe(true)
})

it("expires semantic classifications using the existing cache TTL", async () => {
  vi.mocked(fetch).mockImplementation(async () => response(interpretation()))
  await interpretSemanticIngredient(ingredient("Korianderkörner"))
  const future = Date.now() + config.openFoodFacts.cacheTtlMs + 1
  vi.spyOn(Date, "now").mockReturnValue(future)
  await interpretSemanticIngredient(ingredient("Korianderkörner"))
  expect(fetch).toHaveBeenCalledTimes(2)
})

it("uses a conservative raw default for an unqualified semantic vegetable", async () => {
  vi.mocked(fetch).mockResolvedValue(response(interpretation("broccoli", "unspecified", { category: "vegetable" })))
  const result = await estimateRecipe(recipe(ingredient("Brokkoliröschen")))
  expect(result.matchedIngredients[0]).toMatchObject({ source: "generic", context: { state: "raw" } })
  expect(fetch).toHaveBeenCalledOnce()
})


it("shares interpretation cache when only leading display quantities differ", async () => {
  vi.mocked(fetch).mockImplementation(async () => response(interpretation()))
  const first = ingredient("Korianderkörner"); first.display = "1 TL Korianderkörner"; first.unit!.name = "TL"
  const second = { ...first, quantity: 2, display: "2 TL Korianderkörner" }
  await interpretSemanticIngredient(first)
  await interpretSemanticIngredient(second)
  expect(fetch).toHaveBeenCalledOnce()
})
