import { describe, it, expect, vi, beforeEach } from "vitest"
import { normalizeIngredients } from "../src/services/llm-normalizer.js"
import { config } from "../src/config.js"

beforeEach(() => {
  config.llm.enabled = false
  config.llm.apiKey = ""
  vi.restoreAllMocks()
})

function chatResponse(content: string) {
  return { ok: true, json: async () => ({ choices: [{ message: { content } }] }) }
}

describe("normalizeIngredients", () => {
  it("returns [] for an empty input without calling the LLM", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    const result = await normalizeIngredients([])
    expect(result).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("uses deterministic classification (brand null, generic route) when LLM is disabled — no LLM call at all", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    const result = await normalizeIngredients([
      { index: 0, foodName: "Mehl", unitName: "g" },
      { index: 1, foodName: "Zucker", unitName: "g" },
    ])

    expect(fetchMock).not.toHaveBeenCalled()
    expect(result).toHaveLength(2)
    expect(result[0].brand).toBeNull()
    expect(result[0].route).toBe("generic")
    expect(result[0].llmClassified).toBe(false)
    // Deterministic fallback has no translation available — both fall back to the raw name.
    expect(result[0].canonicalGerman).toBe("Mehl")
    expect(result[0].canonicalEnglish).toBe("Mehl")
  })

  it("makes exactly ONE LLM request for a whole recipe with many ingredients — never one per ingredient", async () => {
    config.llm.enabled = true
    config.llm.apiKey = "test-key"

    const inputs = Array.from({ length: 8 }, (_, i) => ({ index: i, foodName: `Food${i}`, unitName: "g" }))
    const responseItems = inputs.map((i) => ({
      index: i.index, canonicalGerman: i.foodName, canonicalEnglish: i.foodName, brand: null, state: "raw", category: "test",
    }))

    const fetchMock = vi.fn().mockResolvedValue(chatResponse(JSON.stringify(responseItems)))
    vi.stubGlobal("fetch", fetchMock)

    const result = await normalizeIngredients(inputs)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(result).toHaveLength(8)
    expect(result.every((r) => r.llmClassified)).toBe(true)
  })

  it("does NOT fan out into per-ingredient calls when the batch response is malformed — retries once, then falls back deterministically for all", async () => {
    config.llm.enabled = true
    config.llm.apiKey = "test-key"

    const inputs = [
      { index: 0, foodName: "Mehl", unitName: "g" },
      { index: 1, foodName: "Zucker", unitName: "g" },
      { index: 2, foodName: "Salz", unitName: "g" },
    ]

    const fetchMock = vi.fn().mockResolvedValue(chatResponse("this is not json"))
    vi.stubGlobal("fetch", fetchMock)

    const result = await normalizeIngredients(inputs)

    // one initial attempt + exactly one retry = 2 calls total, regardless of ingredient count
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(result).toHaveLength(3)
    expect(result.every((r) => r.llmClassified === false)).toBe(true)
    expect(result.every((r) => r.brand === null)).toBe(true)
    expect(result.map((r) => r.canonicalGerman)).toEqual(["Mehl", "Zucker", "Salz"])
    expect(result.map((r) => r.canonicalEnglish)).toEqual(["Mehl", "Zucker", "Salz"])
  })

  it("falls back deterministically when the LLM request itself fails (network error)", async () => {
    config.llm.enabled = true
    config.llm.apiKey = "test-key"

    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"))
    vi.stubGlobal("fetch", fetchMock)

    const result = await normalizeIngredients([{ index: 0, foodName: "Mehl", unitName: "g" }])
    expect(result[0].llmClassified).toBe(false)
    expect(result[0].canonicalGerman).toBe("Mehl")
    expect(result[0].canonicalEnglish).toBe("Mehl")
  })

  it("preserves nutritionally-relevant qualifiers instead of dropping them during translation", async () => {
    config.llm.enabled = true
    config.llm.apiKey = "test-key"

    const fetchMock = vi.fn().mockResolvedValue(
      chatResponse(JSON.stringify([
        { index: 0, canonicalGerman: "Rinderhackfleisch, mager", canonicalEnglish: "lean ground beef", brand: null, state: "raw", category: "meat" },
        { index: 1, canonicalGerman: "Tomaten, aus der Dose, abgetropft", canonicalEnglish: "tomatoes, canned, drained", brand: null, state: "unknown", category: "vegetable" },
      ])),
    )
    vi.stubGlobal("fetch", fetchMock)

    const result = await normalizeIngredients([
      { index: 0, foodName: "mageres Rinderhackfleisch", unitName: "g" },
      { index: 1, foodName: "Tomaten aus der Dose, abgetropft", unitName: "g" },
    ])

    expect(result[0].canonicalEnglish).toContain("lean")
    expect(result[1].canonicalEnglish).toMatch(/canned|drained/)
  })

  describe("evidence-based brand extraction", () => {
    it("accepts a brand explicitly present in the structured food name", async () => {
      config.llm.enabled = true
      config.llm.apiKey = "test-key"

      const fetchMock = vi.fn().mockResolvedValue(
        chatResponse(JSON.stringify([{ index: 0, canonicalGerman: "Chobani griechischer Joghurt", canonicalEnglish: "Chobani Greek Yogurt", brand: "Chobani", state: "raw", category: "dairy" }])),
      )
      vi.stubGlobal("fetch", fetchMock)

      const result = await normalizeIngredients([{ index: 0, foodName: "Chobani Greek Yogurt", unitName: "g" }])
      expect(result[0].brand).toBe("Chobani")
      expect(result[0].route).toBe("branded")
    })

    it("rejects a brand the LLM invents from world knowledge when it's not in the structured food name", async () => {
      config.llm.enabled = true
      config.llm.apiKey = "test-key"

      const fetchMock = vi.fn().mockResolvedValue(
        chatResponse(JSON.stringify([{ index: 0, canonicalGerman: "griechischer Joghurt", canonicalEnglish: "Greek yogurt", brand: "Chobani", state: "raw", category: "dairy" }])),
      )
      vi.stubGlobal("fetch", fetchMock)

      const result = await normalizeIngredients([{ index: 0, foodName: "griechischer Joghurt", unitName: "g" }])
      expect(result[0].brand).toBeNull()
      expect(result[0].route).toBe("generic")
    })

    it("keeps brand null when the LLM itself returns null (no evidence claimed)", async () => {
      config.llm.enabled = true
      config.llm.apiKey = "test-key"

      const fetchMock = vi.fn().mockResolvedValue(
        chatResponse(JSON.stringify([{ index: 0, canonicalGerman: "Milch", canonicalEnglish: "milk", brand: null, state: "raw", category: "dairy" }])),
      )
      vi.stubGlobal("fetch", fetchMock)

      const result = await normalizeIngredients([{ index: 0, foodName: "Milch", unitName: "g" }])
      expect(result[0].brand).toBeNull()
      expect(result[0].route).toBe("generic")
    })
  })

  it("never includes originalText in the LLM request payload — even if it were attached to the input object", async () => {
    config.llm.enabled = true
    config.llm.apiKey = "test-key"

    const fetchMock = vi.fn().mockResolvedValue(
      chatResponse(JSON.stringify([{ index: 0, canonicalGerman: "Ei", canonicalEnglish: "egg", brand: null, state: "raw", category: "egg" }])),
    )
    vi.stubGlobal("fetch", fetchMock)

    // NormalizerInput has no originalText field at all — buildPrompt only ever reads foodName/
    // unitName. Attaching an extra property (as if a careless future call site forwarded the raw
    // MealieIngredient object) proves the prompt builder can't pick it up even by accident.
    const inputWithStrayOriginalText = {
      index: 0,
      foodName: "Ei",
      unitName: "Stück",
      originalText: "Eier (2 gekocht - mit @organicvalley-handle-should-never-leak)",
    }

    await normalizeIngredients([inputWithStrayOriginalText])

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    const promptText = body.messages[0].content as string
    expect(promptText).not.toContain("@organicvalley-handle-should-never-leak")
    expect(promptText).not.toContain("Eier (2 gekocht")
  })
})
