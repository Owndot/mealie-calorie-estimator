import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest"
import { estimateGrams } from "../src/services/llm-estimator.js"
import { initCache, clearLlmCache } from "../src/utils/cache.js"
import { config } from "../src/config.js"

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
    expect(callArgs.messages[0].content).toContain("Tomaten")
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
    const result = await respond({ kcal: 0, sodium: 39.3, fat: 0, protein: "0" })
    expect(result).toMatchObject({ kcalPer100g: 0, sodiumPer100g: 39.3, fatPer100g: 0, proteinPer100g: 0, unsaturatedFatPer100g: 0 })
    const { estimateNutrients } = await import("../src/services/llm-estimator.js")
    expect(await estimateNutrients("Salz")).toEqual(result)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it.each([null, "", "invalid", -1, "Infinity", true, [], {}])("rejects invalid kcal %j", async kcal => {
    expect(await respond({ kcal, sodium: 39.3 })).toBeNull()
  })

  it("rejects missing kcal without confusing it with zero", async () => {
    expect(await respond({ sodium: 39.3 })).toBeNull()
  })

  it("keeps unknown or invalid nutrients null", async () => {
    const result = await respond({ kcal: 0, sodium: 39.3, fat: null, sugar: -1, protein: "Infinity" })
    expect(result).toMatchObject({ fatPer100g: null, sugarPer100g: null, proteinPer100g: null, carbsPer100g: null })
  })
})
