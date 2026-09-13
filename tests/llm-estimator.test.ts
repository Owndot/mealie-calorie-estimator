import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest"
import { estimateGrams } from "../src/services/llm-estimator.js"
import { initCache, clearLlmCache } from "../src/utils/cache.js"
import { config } from "../src/config.js"
import { contextForName } from "../src/services/ingredient-context.js"

beforeAll(async () => {
  await initCache()
})

beforeEach(() => {
  config.llm.enabled = false
  config.llm.apiKey = ""
  clearLlmCache()
  vi.restoreAllMocks()
})

describe("estimateGrams", () => {
  it("returns null when LLM is disabled", async () => {
    const result = await estimateGrams(2, "Dose", "Tomaten")
    expect(result).toBeNull()
  })

  it("returns null when API key is not set", async () => {
    config.llm.enabled = true
    const result = await estimateGrams(1, "Glas", "Honig")
    expect(result).toBeNull()
  })

  it("returns grams from API and multiplies by quantity", async () => {
    config.llm.enabled = true
    config.llm.apiKey = "sk-test"

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "400" } }],
      }),
    })
    vi.stubGlobal("fetch", mockFetch)

    const result = await estimateGrams(2, "Dose", "Tomaten")
    expect(result).toBe(800)

    expect(mockFetch).toHaveBeenCalledTimes(1)
    const callArgs = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(callArgs.messages[0].content).toContain("Dose")
    expect(callArgs.messages[0].content).toContain("tomato raw")
  })

  it("returns cached value without calling API", async () => {
    config.llm.enabled = true
    config.llm.apiKey = "sk-test"

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "250" } }],
      }),
    })
    vi.stubGlobal("fetch", mockFetch)

    await estimateGrams(1, "Glas", "Gurken")
    const result = await estimateGrams(3, "Glas", "Gurken")
    expect(result).toBe(750)
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it("returns null on API error", async () => {
    config.llm.enabled = true
    config.llm.apiKey = "sk-test"

    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
    })
    vi.stubGlobal("fetch", mockFetch)

    const result = await estimateGrams(1, "Päckchen", "Hefe")
    expect(result).toBeNull()
  })

  it("returns null on invalid response (non-numeric)", async () => {
    config.llm.enabled = true
    config.llm.apiKey = "sk-test"

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "unknown" } }],
      }),
    })
    vi.stubGlobal("fetch", mockFetch)

    const result = await estimateGrams(1, "Bund", "Petersilie")
    expect(result).toBeNull()
  })

  it("returns null on zero response", async () => {
    config.llm.enabled = true
    config.llm.apiKey = "sk-test"

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "0" } }],
      }),
    })
    vi.stubGlobal("fetch", mockFetch)

    const result = await estimateGrams(1, "Stange", "Lauch")
    expect(result).toBeNull()
  })
})

describe("estimateNutrients", () => {
  async function respond(value: unknown) {
    config.llm.enabled = true
    config.llm.apiKey = "sk-test"
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify(value) } }] }),
    }))
    const { estimateNutrients } = await import("../src/services/llm-estimator.js")
    return estimateNutrients("Salz")
  }

  it("preserves and caches zero kcal salt and zero-valued nutrients", async () => {
    const result = await respond({ kcal: 0, sodium: 39300, fat: 0, protein: 0 })
    expect(result).toMatchObject({ kcalPer100g: 0, sodiumPer100g: 39300, fatPer100g: 0, proteinPer100g: 0, unsaturatedFatPer100g: 0 })
    const { estimateNutrients } = await import("../src/services/llm-estimator.js")
    expect(await estimateNutrients("Salz")).toEqual(result)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it.each([null, "", "invalid", -1, "Infinity", true, [], {}])("rejects invalid kcal %j", async kcal => {
    expect(await respond({ kcal, sodium: 39300 })).toBeNull()
  })

  it("rejects missing kcal without confusing it with zero", async () => {
    expect(await respond({ sodium: 39300 })).toBeNull()
  })

  it("rejects invalid nutrients rather than silently dropping them", async () => {
    const result = await respond({ kcal: 0, sodium: 39300, fat: null, sugar: -1, protein: "Infinity" })
    expect(result).toBeNull()
  })

  it("tells the LLM that carbs exclude fiber and keeps fiber separate", async () => {
    config.llm.enabled = true
    config.llm.apiKey = "sk-test"
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ kcal: 325, protein: 14.29, carbs: 2.63, fat: 14.01, saturatedFat: 1.648, transFat: 0, fiber: 53.2, sugar: 2.76, sodium: 52, cholesterol: 0 }) } }] }),
    }))
    const { estimateNutrients } = await import("../src/services/llm-estimator.js")

    const result = await estimateNutrients("Curry powder")

    expect(result).not.toBeNull()
    expect(result?.carbsPer100g).toBeCloseTo(2.63)
    expect(result?.fiberPer100g).toBeCloseTo(53.2)
    expect(result?.carbsPer100g).toBeLessThan(result!.fiberPer100g!)
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string)
    expect(body.messages[0].content).toContain("Carbs means available carbohydrate excluding fiber")
  })
  it("rejects nutrient fallback that contradicts an explicit fat percentage", async () => {
    config.llm.enabled = true
    config.llm.apiKey = "sk-test"
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ kcal: 300, protein: 3, carbs: 5, fat: 30, fiber: 0, sugar: 5 }) } }] }),
    }))
    const { estimateNutrients } = await import("../src/services/llm-estimator.js")
    expect(await estimateNutrients("Kochsahne 7%", contextForName("Kochsahne 7%"))).toBeNull()
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string)
    expect(body.messages[0].content).toContain("7% fat")
    expect(fetch).toHaveBeenCalledTimes(2)
  })
  it("rejects materially inconsistent LLM energy and retries once", async () => {
    config.llm.enabled = true
    config.llm.apiKey = "sk-test"
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ kcal: 120, protein: 2, carbs: 4, fat: 7, fiber: 0 }) } }] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ kcal: 87, protein: 2, carbs: 4, fat: 7, fiber: 0 }) } }] }) }))
    const { estimateNutrients } = await import("../src/services/llm-estimator.js")
    const result = await estimateNutrients("Kochsahne 7%", contextForName("Kochsahne 7%"))
    expect(result?.kcalPer100g).toBe(87)
    expect(fetch).toHaveBeenCalledTimes(2)
    const retryPrompt = JSON.parse(vi.mocked(fetch).mock.calls[1][1]!.body as string).messages[0].content
    expect(retryPrompt).toContain("ensure kcal is consistent")
  })
  it("accepts high-fiber energy represented above macro 4/4/9", async () => {
    const result = await respond({ kcal: 325, protein: 14.29, carbs: 2.63, fat: 14.01, fiber: 53.2, sugar: 2.76 })
    expect(result).not.toBeNull()
  })
})

it("specifies mass basis, milligrams and uncertainty in the nutrient prompt", async () => {
  config.llm.enabled = true
  config.llm.apiKey = "sk-test"
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ choices: [{ message: { content: "null" } }] }) }))
  const { estimateNutrients } = await import("../src/services/llm-estimator.js")
  expect(await estimateNutrients("Kidneybohnen gekocht")).toBeNull()
  const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string)
  expect(body.messages[0].content).toContain("milligrams (mg) per 100 g")
  expect(body.messages[0].content).toContain("kidney beans cooked")
  expect(body.messages[0].content).toContain("JSON null")
})

it.each(["1.5", "1.5 g", "Infinity", "20"])("strictly parses and bounds teaspoon gram response %s", async content => {
  config.llm.enabled = true
  config.llm.apiKey = "sk-test"
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ choices: [{ message: { content } }] }) }))
  const result = await estimateGrams(2, "TL", "unknown spice")
  expect(result).toBe(content === "1.5" ? 3 : null)
})

it("never asks the LLM for pinch weight, even when enabled", async () => {
  config.llm.enabled = true
  config.llm.apiKey = "sk-test"
  vi.stubGlobal("fetch", vi.fn())
  expect(await estimateGrams(1, "Prise", "Salz")).toBe(0.25)
  expect(fetch).not.toHaveBeenCalled()
})

it("separates dry and cooked LLM nutrient caches", async () => {
  config.llm.enabled = true
  config.llm.apiKey = "sk-test"
  vi.stubGlobal("fetch", vi.fn().mockImplementation(async (_url, options) => {
    const prompt = JSON.parse(options.body).messages[0].content
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ kcal: prompt.includes("ingredient: \"rice cooked\"") ? 130 : 365 }) } }] }) }
  }))
  const { estimateNutrients } = await import("../src/services/llm-estimator.js")
  expect((await estimateNutrients("Reis trocken"))?.kcalPer100g).toBe(365)
  expect((await estimateNutrients("Reis gekocht"))?.kcalPer100g).toBe(130)
  expect((await estimateNutrients("rice dry"))?.kcalPer100g).toBe(365)
  expect(fetch).toHaveBeenCalledTimes(2)
})
