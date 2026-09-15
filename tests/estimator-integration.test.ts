import { describe, it, expect, beforeEach, beforeAll, vi } from "vitest"
import { estimateRecipe, computeIngredientHash } from "../src/services/estimator.js"
import { config } from "../src/config.js"
import { initCache } from "../src/utils/cache.js"
import { __buildTestBlsData, __resetBlsDataForTests } from "../src/services/providers/bls-provider.js"
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
  // This file exercises the USDA path specifically (its describe title says so) — BLS is now
  // unconditionally ahead of USDA in the real generic chain and would otherwise intercept common
  // German words (Mehl, Zucker, Reis, Ei, ...) with real bundled data before USDA ever runs.
  __resetBlsDataForTests(Promise.resolve(__buildTestBlsData([])))
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
    // Provenance: dataType flows all the way from the USDA response through to IngredientMatch.
    expect(result.matchedIngredients[0].dataType).toBe("Foundation")
    expect(result.matchedIngredients[0].providerId).toBeTruthy()

    const { buildNutritionPatch } = await import("../src/services/estimator.js")
    const patch = buildNutritionPatch(result, "hash", null)
    const persistedProvenance = JSON.parse(patch.extras.calorie_estimator_provenance)
    expect(persistedProvenance[0].dataType).toBe("Foundation")
    expect(persistedProvenance[0].providerId).toBeTruthy()
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

  it("an ingredient resolved purely via the LLM nutrient fallback is tagged fallbackStatus 'llm-nutrient' and counted as llmParticipated", async () => {
    config.llm.enabled = true
    config.llm.apiKey = "test-key"
    // USDA left unconfigured -> the generic route's only provider is the LLM nutrient fallback.

    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const body = JSON.parse((init as RequestInit).body as string)
      const prompt = body.messages[0].content as string

      if (prompt.includes("Return ONLY a JSON array")) {
        // whole-recipe batch normalizer request
        return new Response(
          JSON.stringify({ choices: [{ message: { content: JSON.stringify([{ index: 0, canonicalName: "Seltener Fisch", brand: null, state: "raw", category: "fish" }]) } }] }),
          { status: 200 },
        )
      }

      // per-ingredient LLM nutrient fallback request
      return new Response(
        JSON.stringify({
          choices: [{
            message: {
              content: JSON.stringify({ kcal: 120, protein: 20, carbs: 0, fat: 4, saturatedFat: 1, transFat: 0, fiber: 0, sugar: 0, sodium: 0.08, cholesterol: 0.05 }),
            },
          }],
        }),
        { status: 200 },
      )
    })

    const r = recipe({
      recipeServings: 4,
      recipeIngredient: [ing({ quantity: 100, food: { id: "1", name: "Seltener Fisch", pluralName: null, aliases: [] } })],
    })

    const result = await estimateRecipe(r)

    expect(result.matchedIngredients[0].matched).toBe(true)
    expect(result.matchedIngredients[0].fallbackStatus).toBe("llm-nutrient")
    expect(result.matchedIngredients[0].llmParticipated).toBe(true)

    const { buildNutritionPatch } = await import("../src/services/estimator.js")
    const patch = buildNutritionPatch(result, "hash", null)
    expect(JSON.parse(patch.extras.calorie_estimator_llm_ingredients)).toContain("Seltener Fisch")
  })

  it("originalText never influences the hash or the estimate, even when it contradicts structured data", async () => {
    // BLS is emptied (see beforeEach) and USDA is unconfigured (default apiKey "" in this file's
    // beforeEach) — OFF is still unconditionally in the generic chain as a last-resort DB
    // fallback, so it must be given a controlled empty response rather than hitting the real
    // network in a test.
    mockUsdaProvider({})

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

// The 75 kg incident's proximate trigger: a deterministic density SHOULD have resolved the broth,
// but the table couldn't see the German compound, so the ingredient reached the LLM gram estimator
// — which is the only path that can produce a physically impossible number. Whenever the table can
// answer, that path must not be reached at all.
describe("deterministic density short-circuits the LLM gram estimator", () => {
  const ML = { id: "ml", name: "Milliliter", pluralName: "Milliliter", abbreviation: "ml", standardQuantity: 1, standardUnit: "milliliter" }

  beforeEach(() => {
    config.llm.enabled = true
    config.llm.apiKey = "test-key"
  })

  it("never calls the LLM for grams when the density table resolves the ingredient", async () => {
    // Providers share global fetch, so record URLs instead of throwing: an empty provider result
    // lets OFF/USDA miss cleanly and fast, while any LLM call still shows up in the recorded list.
    // Only GRAM-estimate prompts matter here; the llm-nutrient fallback legitimately calls the LLM
    // because every provider is stubbed empty.
    const gramPrompts: string[] = []
    const fetchMock = vi.fn(async (url: any, init: any) => {
      const body = typeof init?.body === "string" ? init.body : ""
      if (body.includes("Estimate the weight in grams")) gramPrompts.push(body)
      return { ok: true, status: 200, json: async () => ({ products: [], foods: [] }) } as any
    })
    vi.stubGlobal("fetch", fetchMock)

    for (const name of ["Gemüsebrühe", "Hühnerbrühe", "Kokosmilch", "Schlagsahne", "Orangensaft", "Leitungswasser", "Rotwein", "Olivenöl", "Sonnenblumenöl"]) {
      const r = recipe({
        recipeServings: 1,
        recipeIngredient: [ing({ quantity: 750, unit: ML, food: { id: "x", name, pluralName: null, aliases: [] } })],
      })
      const result = await estimateRecipe(r)
      const match = result!.matchedIngredients[0]
      expect(match.grams, `${name} should resolve deterministically`).not.toBeNull()
      // 750 ml of a water-based liquid is 750 g; oils are ~91% of that.
      expect(match.grams!).toBeGreaterThan(600)
      expect(match.grams!).toBeLessThan(800)
    }

    expect(gramPrompts).toEqual([])
  })

  it("750 ml Gemüsebrühe resolves to 750 g — the exact live regression", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ products: [], foods: [] }) }) as any))
    const r = recipe({
      recipeServings: 1,
      recipeIngredient: [ing({ quantity: 750, unit: ML, food: { id: "x", name: "Gemüsebrühe", pluralName: null, aliases: [] } })],
    })
    const result = await estimateRecipe(r)
    expect(result!.matchedIngredients[0].grams).toBe(750) // not 75000
  })
})
