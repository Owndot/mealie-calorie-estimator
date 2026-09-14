import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest"
import { estimateGrams, estimateNutrients } from "../src/services/llm-estimator.js"
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

describe("estimateNutrients — final per-ingredient fallback only", () => {
  it("returns null when LLM is disabled", async () => {
    const result = await estimateNutrients("Quinoa")
    expect(result).toBeNull()
  })

  it("parses a valid nutrient JSON response, computing unsaturated fat from fat - sat - trans", async () => {
    config.llm.enabled = true
    config.llm.apiKey = "sk-test"

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            content: JSON.stringify({ kcal: 150, protein: 5, carbs: 10, fat: 8, saturatedFat: 2, transFat: 0, fiber: 1, sugar: 2, sodium: 0.1, cholesterol: 0.01 }),
          },
        }],
      }),
    })
    vi.stubGlobal("fetch", mockFetch)

    const result = await estimateNutrients("Obscure Dish")
    expect(result?.kcalPer100g).toBe(150)
    expect(result?.unsaturatedFatPer100g).toBe(6)
    expect(result?.sodiumPer100g).toBe(0.1)
  })

  it("caches results and does not re-call the API for a repeat food", async () => {
    config.llm.enabled = true
    config.llm.apiKey = "sk-test"

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ kcal: 90, protein: 1, carbs: 20, fat: 0.5, saturatedFat: 0, transFat: 0, fiber: 2, sugar: 15, sodium: 0.001, cholesterol: 0 }) } }] }),
    })
    vi.stubGlobal("fetch", mockFetch)

    await estimateNutrients("Repeatfood")
    await estimateNutrients("Repeatfood")
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it("discards a zero-kcal response rather than caching/returning it", async () => {
    config.llm.enabled = true
    config.llm.apiKey = "sk-test"

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ kcal: 0, protein: 0, carbs: 0, fat: 0, saturatedFat: 0, transFat: 0, fiber: 0, sugar: 0, sodium: 0, cholesterol: 0 }) } }] }),
    })
    vi.stubGlobal("fetch", mockFetch)

    const result = await estimateNutrients("Zerokcalfood")
    expect(result).toBeNull()
  })

  it("fails safely on malformed JSON rather than throwing", async () => {
    config.llm.enabled = true
    config.llm.apiKey = "sk-test"

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "not valid json" } }] }),
    })
    vi.stubGlobal("fetch", mockFetch)

    const result = await estimateNutrients("Malformedfood")
    expect(result).toBeNull()
  })

  it("returns null on API error", async () => {
    config.llm.enabled = true
    config.llm.apiKey = "sk-test"

    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 500 })
    vi.stubGlobal("fetch", mockFetch)

    const result = await estimateNutrients("Errorfood")
    expect(result).toBeNull()
  })
})
