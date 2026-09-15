import { describe, it, expect, vi, beforeEach } from "vitest"
import { normalizeIngredients } from "../src/services/llm-normalizer.js"
import { config } from "../src/config.js"
import { logger } from "../src/utils/logger.js"

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
      index: i.index, canonicalGerman: i.foodName, canonicalEnglish: i.foodName, brand: null, state: "raw", category: "test", foodType: "simple", coreFoodGerman: i.foodName, coreFoodEnglish: i.foodName,
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
        { index: 0, canonicalGerman: "Rinderhackfleisch, mager", canonicalEnglish: "lean ground beef", brand: null, state: "raw", category: "meat", foodType: "simple", coreFoodGerman: "Rinderhackfleisch", coreFoodEnglish: "ground beef" },
        { index: 1, canonicalGerman: "Tomaten, aus der Dose, abgetropft", canonicalEnglish: "tomatoes, canned, drained", brand: null, state: "unknown", category: "vegetable", foodType: "processed_single_food", coreFoodGerman: "Tomaten", coreFoodEnglish: "tomatoes" },
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
        chatResponse(JSON.stringify([{ index: 0, canonicalGerman: "Chobani griechischer Joghurt", canonicalEnglish: "Chobani Greek Yogurt", brand: "Chobani", state: "raw", category: "dairy", foodType: "processed_single_food", coreFoodGerman: "Joghurt", coreFoodEnglish: "yogurt" }])),
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
        chatResponse(JSON.stringify([{ index: 0, canonicalGerman: "griechischer Joghurt", canonicalEnglish: "Greek yogurt", brand: "Chobani", state: "raw", category: "dairy", foodType: "simple", coreFoodGerman: "Joghurt", coreFoodEnglish: "yogurt" }])),
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
        chatResponse(JSON.stringify([{ index: 0, canonicalGerman: "Milch", canonicalEnglish: "milk", brand: null, state: "raw", category: "dairy", foodType: "simple", coreFoodGerman: "Milch", coreFoodEnglish: "milk" }])),
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
      chatResponse(JSON.stringify([{ index: 0, canonicalGerman: "Ei", canonicalEnglish: "egg", brand: null, state: "raw", category: "egg", foodType: "simple", coreFoodGerman: "Ei", coreFoodEnglish: "egg" }])),
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

  it("prompts the LLM to use \"water\"/\"beverage\"/\"condiment\"/\"seasoning\" as category values, not just the food-group examples", async () => {
    // Found live: "Wasser" matched USDA's "Crackers, water biscuits" despite categoryConflict("water",
    // "Crackers, water biscuits") already returning true — the LLM was never actually prompted with
    // "water"/"beverage"/"condiment"/"seasoning" as example category values (only spice/herb/vegetable/
    // fruit/dairy/egg/meat/grain/legume/fat/oil), so it had no reason to ever assign them, leaving
    // categoryConflict permanently inert for these foods regardless of how correct the check itself was.
    config.llm.enabled = true
    config.llm.apiKey = "test-key"

    const fetchMock = vi.fn().mockResolvedValue(
      chatResponse(JSON.stringify([{ index: 0, canonicalGerman: "Wasser", canonicalEnglish: "water", brand: null, state: "unknown", category: "water", foodType: "simple", coreFoodGerman: "Wasser", coreFoodEnglish: "water" }])),
    )
    vi.stubGlobal("fetch", fetchMock)

    await normalizeIngredients([{ index: 0, foodName: "Wasser", unitName: "ml" }])

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    const promptText = body.messages[0].content as string
    expect(promptText).toContain("water")
    expect(promptText).toContain("beverage")
    expect(promptText).toContain("condiment")
    expect(promptText).toContain("seasoning")
  })
})

// Found live: a real recipe's whole-recipe classification collapsed to the deterministic fallback
// twice, and production logs could not say why — every failure class logged the same `count`, and
// a non-string `content` field logged nothing at all. These pin each class to its own phase tag so
// the next incident is diagnosable from the logs alone. Behaviour is deliberately unchanged: every
// case below still ends in the all-deterministic fallback.
describe("batch normalization failure diagnostics", () => {
  const INPUTS = [
    { index: 0, foodName: "Gemüsebrühe", unitName: "Milliliter" },
    { index: 1, foodName: "Rote Linse", unitName: "g" },
  ]

  function captureWarnings() {
    return vi.spyOn(logger, "warn").mockImplementation(() => logger as never)
  }
  const phasesOf = (spy: ReturnType<typeof captureWarnings>) =>
    spy.mock.calls.map((c) => (typeof c[0] === "object" && c[0] !== null ? (c[0] as Record<string, unknown>).phase : undefined)).filter(Boolean)

  beforeEach(() => {
    config.llm.enabled = true
    config.llm.apiKey = "test-key"
  })

  it("distinguishes a network/request failure", async () => {
    const warn = captureWarnings()
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("boom") }))
    const result = await normalizeIngredients(INPUTS)
    expect(phasesOf(warn)).toEqual(["request-network", "request-network"])
    expect(result.every((r) => r.llmClassified === false)).toBe(true)
  })

  it("distinguishes an HTTP error status from a network failure", async () => {
    const warn = captureWarnings()
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })))
    await normalizeIngredients(INPUTS)
    expect(phasesOf(warn)).toEqual(["request-status", "request-status"])
    expect(warn.mock.calls[0][0]).toMatchObject({ status: 503 })
  })

  it("distinguishes an unparseable-JSON content field", async () => {
    const warn = captureWarnings()
    vi.stubGlobal("fetch", vi.fn(async () => chatResponse("this is not json")))
    await normalizeIngredients(INPUTS)
    expect(phasesOf(warn)).toEqual(["json", "json"])
  })

  it("distinguishes a wrong response shape (valid JSON, not an array of the expected size)", async () => {
    const warn = captureWarnings()
    vi.stubGlobal("fetch", vi.fn(async () => chatResponse(JSON.stringify({ items: [] }))))
    await normalizeIngredients(INPUTS)
    expect(phasesOf(warn)).toEqual(["shape", "shape"])
    expect(warn.mock.calls[0][0]).toMatchObject({ isArray: false, expected: 2 })
  })

  it("distinguishes a per-item validation failure and names the offending index and field", async () => {
    const warn = captureWarnings()
    const good = { index: 0, canonicalGerman: "Gemüsebrühe", canonicalEnglish: "vegetable broth", brand: null,
      state: "unknown", category: "water", foodType: "processed_single_food", coreFoodGerman: "Brühe", coreFoodEnglish: "broth" }
    const bad = { ...good, index: 1, canonicalGerman: "Rote Linse", canonicalEnglish: "red lentil", state: "canned" }
    vi.stubGlobal("fetch", vi.fn(async () => chatResponse(JSON.stringify([good, bad]))))

    await normalizeIngredients(INPUTS)

    expect(phasesOf(warn)).toEqual(["items", "items"])
    expect(warn.mock.calls[0][0]).toMatchObject({
      expected: 2, validCount: 1, invalidCount: 1,
      failures: [{ position: 1, index: 1, field: "state", reason: "not in allowed enum", value: "canned" }],
    })
  })

  it("reports the previously-silent case where the response envelope has no string content", async () => {
    const warn = captureWarnings()
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ choices: [{ finish_reason: "length", message: {} }] }) })))
    await normalizeIngredients(INPUTS)
    expect(phasesOf(warn)).toEqual(["response-shape", "response-shape"])
    expect(warn.mock.calls[0][0]).toMatchObject({ contentType: "undefined", finishReason: "length" })
  })

  it("never logs the raw response content or the API key", async () => {
    const warn = captureWarnings()
    vi.stubGlobal("fetch", vi.fn(async () => chatResponse("SECRET-RESPONSE-BODY not json")))
    await normalizeIngredients(INPUTS)
    const serialized = JSON.stringify(warn.mock.calls)
    expect(serialized).not.toContain("SECRET-RESPONSE-BODY")
    expect(serialized).not.toContain("test-key")
  })
})

// Found live: `Tomatenmark` came back as state:"processed" (not in the enum) and the old
// all-or-nothing validation threw away all 15 classifications for the recipe — which is what let
// 750 ml Gemuesebruehe resolve from its raw German name to 75000 g. One bad item must now cost
// exactly one ingredient.
describe("per-item recovery and coverage-based retry", () => {
  const good = (index: number, de: string, en: string) => ({
    index, canonicalGerman: de, canonicalEnglish: en, brand: null, state: "unknown",
    category: null, foodType: "simple", coreFoodGerman: de, coreFoodEnglish: en,
  })
  const inputs = (n: number) => Array.from({ length: n }, (_, i) => ({ index: i, foodName: `Food${i}`, unitName: "g" }))

  beforeEach(() => {
    config.llm.enabled = true
    config.llm.apiKey = "test-key"
  })

  it("keeps the 14 valid items when 1 of 15 fails validation, and does NOT retry at 93% coverage", async () => {
    const items = inputs(15).map((i) => good(i.index, `DE${i.index}`, `en${i.index}`))
    ;(items[8] as any).state = "processed" // the exact live failure
    const fetchMock = vi.fn(async () => chatResponse(JSON.stringify(items)))
    vi.stubGlobal("fetch", fetchMock)

    const result = await normalizeIngredients(inputs(15))

    expect(fetchMock).toHaveBeenCalledTimes(1) // coverage 14/15 = 93% >= 80%, no retry
    expect(result.filter((r) => r.llmClassified)).toHaveLength(14)
    expect(result[8].llmClassified).toBe(false)
    expect(result[8].canonicalEnglish).toBe("Food8") // deterministic fallback, alone
    expect(result[0].canonicalEnglish).toBe("en0")   // neighbours untouched
    expect(result[14].canonicalEnglish).toBe("en14")
  })

  it("retries once when coverage is below the threshold (2 of 15 valid)", async () => {
    const first = [good(0, "DE0", "en0"), good(1, "DE1", "en1")]
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(chatResponse(JSON.stringify(first)))
      .mockResolvedValueOnce(chatResponse(JSON.stringify(inputs(15).map((i) => good(i.index, `R${i.index}`, `r${i.index}`)))))
    vi.stubGlobal("fetch", fetchMock)

    const result = await normalizeIngredients(inputs(15))

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(result.every((r) => r.llmClassified)).toBe(true)
    // attempt 1 wins for the indices it supplied; the retry only fills the rest
    expect(result[0].canonicalEnglish).toBe("en0")
    expect(result[1].canonicalEnglish).toBe("en1")
    expect(result[2].canonicalEnglish).toBe("r2")
  })

  it("never lets a retry overwrite an item that already validated in attempt 1", async () => {
    // Attempt 1 supplies index 0 (below threshold, so a retry happens); the retry returns a
    // DIFFERENT but perfectly valid classification for index 0. Attempt 1 must still win.
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(chatResponse(JSON.stringify([good(0, "Zwiebel", "onion")])))
      .mockResolvedValueOnce(chatResponse(JSON.stringify([good(0, "Knoblauch", "garlic"), good(1, "Salz", "salt")])))
    vi.stubGlobal("fetch", fetchMock)

    const result = await normalizeIngredients(inputs(2))

    expect(result[0].canonicalEnglish).toBe("onion")  // NOT "garlic"
    expect(result[0].canonicalGerman).toBe("Zwiebel")
    expect(result[1].canonicalEnglish).toBe("salt")   // filled by the retry
  })

  it("associates items by their returned index, not by array position (reordered response)", async () => {
    const shuffled = [good(2, "DE2", "en2"), good(0, "DE0", "en0"), good(1, "DE1", "en1")]
    vi.stubGlobal("fetch", vi.fn(async () => chatResponse(JSON.stringify(shuffled))))

    const result = await normalizeIngredients(inputs(3))

    expect(result.map((r) => r.canonicalEnglish)).toEqual(["en0", "en1", "en2"])
  })

  it("rejects a duplicate index instead of letting it overwrite its twin", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => logger as never)
    // Both claim index 0; the second is unattributable and must be dropped, not applied.
    vi.stubGlobal("fetch", vi.fn(async () => chatResponse(JSON.stringify([good(0, "Zwiebel", "onion"), good(0, "Knoblauch", "garlic")]))))

    const result = await normalizeIngredients(inputs(2))

    expect(result[0].canonicalEnglish).toBe("onion") // first wins, duplicate discarded
    expect(result[1].llmClassified).toBe(false)      // never supplied -> deterministic
    expect(warn.mock.calls.some((c) => (c[0] as any)?.indexIssues?.duplicate === 1)).toBe(true)
  })

  it("rejects out-of-range indices (e.g. a 1-based response) rather than misattributing them", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => logger as never)
    vi.stubGlobal("fetch", vi.fn(async () => chatResponse(JSON.stringify([good(1, "DE1", "en1"), good(2, "DE2", "en2")]))))

    const result = await normalizeIngredients(inputs(2))

    expect(result[1].canonicalEnglish).toBe("en1") // index 1 is in range and legitimately applies
    expect(result[0].llmClassified).toBe(false)    // index 2 is out of range -> dropped
    expect(warn.mock.calls.some((c) => (c[0] as any)?.indexIssues?.outOfRange === 1)).toBe(true)
  })

  it("rejects a non-integer index", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => chatResponse(JSON.stringify([{ ...good(0, "DE", "en"), index: 0.5 }]))))
    const result = await normalizeIngredients(inputs(1))
    expect(result[0].llmClassified).toBe(false)
  })

  it("still falls back deterministically for every ingredient when nothing validates", async () => {
    const fetchMock = vi.fn(async () => chatResponse(JSON.stringify([{ index: 0, bogus: true }])))
    vi.stubGlobal("fetch", fetchMock)
    const result = await normalizeIngredients(inputs(3))
    expect(fetchMock).toHaveBeenCalledTimes(2) // 0% coverage -> one retry
    expect(result.every((r) => r.llmClassified === false)).toBe(true)
  })
})

// The live failure was state:"processed" on Tomatenmark, six times in a row. The old retry hint
// asserted the response "was not valid JSON matching the required shape" — but the JSON was
// perfect, so the model had no reason to change the one offending field.
describe("enum guidance and retry correction", () => {
  const promptOf = (m: any, call = 0) => JSON.parse(m.mock.calls[call][1].body).messages[0].content

  beforeEach(() => {
    config.llm.enabled = true
    config.llm.apiKey = "test-key"
  })

  it("tells the model that state is preparation-only and that 'processed' is invalid there", async () => {
    const fetchMock = vi.fn(async () => chatResponse("[]"))
    vi.stubGlobal("fetch", fetchMock)
    await normalizeIngredients([{ index: 0, foodName: "Tomatenmark", unitName: "g" }])

    const p = promptOf(fetchMock)
    expect(p).toMatch(/"processed"/)
    expect(p).toMatch(/INVALID values for state|not allowed/i)
    expect(p).toMatch(/preparation state/i)
    // and it must still name the four legal values
    for (const v of ["raw", "cooked", "dried", "unknown"]) expect(p).toContain(`"${v}"`)
  })

  it("the retry names the offending index, field, value and the allowed set — not 'invalid JSON'", async () => {
    const bad = { index: 0, canonicalGerman: "Tomatenmark", canonicalEnglish: "tomato paste", brand: null,
      state: "processed", category: "vegetable", foodType: "processed_single_food", coreFoodGerman: "Tomatenmark", coreFoodEnglish: "tomato paste" }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(chatResponse(JSON.stringify([bad])))
      .mockResolvedValueOnce(chatResponse(JSON.stringify([{ ...bad, state: "unknown" }])))
    vi.stubGlobal("fetch", fetchMock)

    const result = await normalizeIngredients([{ index: 0, foodName: "Tomatenmark", unitName: "g" }])

    const retry = promptOf(fetchMock, 1)
    expect(retry).toContain('index 0: "state" was "processed"')
    expect(retry).toContain('"raw", "cooked", "dried", "unknown"')
    expect(retry).not.toMatch(/was not valid JSON/i)
    // and the corrected retry value is actually adopted
    expect(result[0].llmClassified).toBe(true)
    expect(result[0].state).toBe("unknown")
  })

  it("the retry explains an unusable index instead of blaming JSON validity", async () => {
    const item = (index: unknown) => ({ index, canonicalGerman: "X", canonicalEnglish: "x", brand: null,
      state: "raw", category: null, foodType: "simple", coreFoodGerman: null, coreFoodEnglish: null })
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(chatResponse(JSON.stringify([item(0), item(0)])))
      .mockResolvedValueOnce(chatResponse(JSON.stringify([item(0), item(1)])))
    vi.stubGlobal("fetch", fetchMock)

    await normalizeIngredients([{ index: 0, foodName: "A", unitName: "g" }, { index: 1, foodName: "B", unitName: "g" }])

    expect(promptOf(fetchMock, 1)).toMatch(/unusable "index"/)
  })
})
