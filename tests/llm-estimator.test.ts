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

  it("accepts a genuine zero-kcal response (e.g. salt/water) instead of discarding it — regression for a live-found bug", async () => {
    // Real bug found via the live acceptance suite: `Number(json.kcal) || null` silently turned
    // a correct kcal:0 answer (salt) into null, which then made the caller discard the whole
    // estimate as if the LLM had failed — even though it had answered correctly. "Unknown does
    // not mean zero" cuts both ways: a genuine zero must not be laundered into "unknown" either.
    config.llm.enabled = true
    config.llm.apiKey = "sk-test"

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ kcal: 0, protein: 0, carbs: 0, fat: 0, saturatedFat: 0, transFat: 0, fiber: 0, sugar: 0, sodium: 38, cholesterol: 0 }) } }] }),
    })
    vi.stubGlobal("fetch", mockFetch)

    const result = await estimateNutrients("Salz")
    expect(result).not.toBeNull()
    expect(result?.kcalPer100g).toBe(0)
    expect(result?.sodiumPer100g).toBe(38)
  })

  it("still discards a response with no usable kcal value at all (missing/non-numeric)", async () => {
    config.llm.enabled = true
    config.llm.apiKey = "sk-test"

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ protein: 0, carbs: 0, fat: 0 }) } }] }), // no "kcal" key at all
    })
    vi.stubGlobal("fetch", mockFetch)

    const result = await estimateNutrients("Missingkcalfood")
    expect(result).toBeNull()
  })

  it("preserves other genuine zero values (e.g. 0g fat) instead of nulling them out", async () => {
    config.llm.enabled = true
    config.llm.apiKey = "sk-test"

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ kcal: 130, protein: 2.7, carbs: 28, fat: 0, saturatedFat: 0, transFat: 0, fiber: 0.4, sugar: 0.1, sodium: 0.001, cholesterol: 0 }) } }] }),
    })
    vi.stubGlobal("fetch", mockFetch)

    const result = await estimateNutrients("Zerofatfood")
    expect(result?.fatPer100g).toBe(0)
    expect(result?.cholesterolPer100g).toBe(0)
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

// Found live: "750 Milliliter Gemuesebruehe" reached this estimator because the density table
// missed the German compound, the model answered "100" to "grams for 1 Milliliter" (a per-100ml
// answer to a per-1ml question), and 100 x 750 = 75000 g was multiplied AND cached with nothing
// in between inspecting it. The recipe then read 1831 kcal/serving instead of 396.
describe("volume units: g/ml contract and catastrophic-error guard", () => {
  const reply = (n: string) => ({ ok: true, json: async () => ({ choices: [{ message: { content: n } }] }) })

  beforeEach(() => {
    config.llm.enabled = true
    config.llm.apiKey = "test-key"
  })

  it("asks for a reference volume (100 ml), not for 1 ml", async () => {
    const fetchMock = vi.fn(async () => reply("100"))
    vi.stubGlobal("fetch", fetchMock)
    await estimateGrams(750, "Milliliter", "Gemüsebrühe")
    const prompt = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, { body: string }])[1].body).messages[0].content
    expect(prompt).toContain("100 ml")
    expect(prompt).not.toMatch(/for 1 Milliliter/)
  })

  it("interprets the answer as grams per 100 ml — 750 ml of broth is 750 g, not 75000 g", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply("100")))
    expect(await estimateGrams(750, "Milliliter", "Gemüsebrühe")).toBe(750)
  })

  it("rejects a physically impossible density before multiplying AND before caching", async () => {
    // 5000 g per 100 ml = 50 g/ml — the same class of answer as the live 100 g/ml.
    const fetchMock = vi.fn(async () => reply("5000"))
    vi.stubGlobal("fetch", fetchMock)

    expect(await estimateGrams(750, "Milliliter", "Gemüsebrühe")).toBeNull()

    // Nothing was written: a second call must go back to the LLM rather than replay the poison.
    await estimateGrams(750, "Milliliter", "Gemüsebrühe")
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("rejects an impossibly light density too", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply("1"))) // 0.01 g/ml
    expect(await estimateGrams(500, "ml", "Suppe")).toBeNull()
  })

  it("accepts the full range of real foods (oil, water, honey)", async () => {
    for (const [answer, expected] of [["91", 91], ["100", 100], ["142", 142]] as const) {
      clearLlmCache()
      vi.stubGlobal("fetch", vi.fn(async () => reply(answer)))
      expect(await estimateGrams(100, "ml", `food-${answer}`)).toBeCloseTo(expected, 6)
    }
  })

  it("shares one density entry between Milliliter and Liter — they can never disagree", async () => {
    const fetchMock = vi.fn(async () => reply("100"))
    vi.stubGlobal("fetch", fetchMock)

    expect(await estimateGrams(500, "Milliliter", "Brühe")).toBe(500)
    expect(await estimateGrams(1.5, "Liter", "Brühe")).toBe(1500) // cache hit, scaled by 1000
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("leaves piece/package units on the per-unit contract with no density bound", async () => {
    const fetchMock = vi.fn(async () => reply("5000"))
    vi.stubGlobal("fetch", fetchMock)
    // 5 kg for one Dose is unusual but legitimate (catering tin) — deliberately NOT rejected.
    expect(await estimateGrams(1, "Dose", "Tomaten")).toBe(5000)
    const prompt = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, { body: string }])[1].body).messages[0].content
    expect(prompt).toContain("1 Dose")
  })
})
