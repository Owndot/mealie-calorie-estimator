import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest"
import { config } from "../src/config.js"
import { initCache, clearLlmCache, getCachedClassification, setCachedClassification } from "../src/utils/cache.js"
import { normalizeIngredients, classificationCacheKey, type NormalizerInput } from "../src/services/llm-normalizer.js"
import { statedPreparation, reconcileState } from "../src/services/providers/food-semantics.js"
import type { FoodState } from "../src/types.js"

/**
 * CLASSIFICATION STABILITY.
 *
 * Measured in production before this change: ten consecutive estimates of one UNCHANGED recipe
 * classified "300 g Nudeln" as cooked eight times and raw twice, moving the whole recipe between
 * 2004 and 2604 kcal — a 200 kcal-per-serving swing with no input of any kind having changed.
 *
 * Three independent defences, tested here:
 *   temperature 0        removes the sampling variance at its source;
 *   reconcileState()     refuses a preparation the ingredient text does not state;
 *   classification cache makes the surviving interpretation stick across runs.
 *
 * The semantic rule under test is NOT "no adjective means fresh". It is: an unqualified quantity
 * refers to the state the ingredient is bought and MEASURED in, and a later preparation step
 * cannot change that retroactively.
 */

const VALID = {
  index: 0, canonicalGerman: "x", canonicalEnglish: "x", brand: null, state: "raw",
  form: "unknown", preservation: "unknown", fatPercent: null, category: "grain",
  foodType: "simple", coreFoodGerman: "x", coreFoodEnglish: "x",
}

/** One classifier response, for a batch of `n`, with per-index overrides. */
function reply(n: number, overrides: Record<number, Record<string, unknown>> = {}): string {
  return JSON.stringify(
    Array.from({ length: n }, (_, i) => ({ ...VALID, index: i, ...(overrides[i] ?? {}) })),
  )
}

const CHAT = (content: string) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200, headers: { "content-type": "application/json" },
  })

const ing = (index: number, foodName: string, unitName: string | null = "g"): NormalizerInput =>
  ({ index, foodName, unitName })

beforeAll(async () => { await initCache() })

beforeEach(() => {
  clearLlmCache()
  config.llm.enabled = true
  config.llm.apiKey = "test-key"
})
afterEach(() => { vi.unstubAllGlobals() })

// ---------------------------------------------------------------------------------------------

describe("the state a text actually STATES", () => {
  const cases: [string, FoodState][] = [
    // Nothing stated — the overwhelmingly common case, and the one that was unstable.
    ["Nudeln", "unknown"],
    ["300 g Nudeln", "unknown"],
    ["Reis", "unknown"],
    ["schwarze Bohnen", "unknown"],
    ["Rinderhackfleisch", "unknown"],
    ["Tomaten", "unknown"],
    ["Zwiebeln", "unknown"],
    ["Kartoffeln", "unknown"],
    ["Paprikapulver", "unknown"],
    // Stated preparations, German and English, including inflected adjective endings.
    ["gekochter Reis", "cooked"],
    ["gekochte Nudeln", "cooked"],
    ["vorgekochte Nudeln", "cooked"],
    ["gegarte Kartoffeln", "cooked"],
    ["gebratenes Hähnchen", "cooked"],
    ["cooked rice", "cooked"],
    ["precooked pasta", "cooked"],
    ["rohes Rinderhackfleisch", "raw"],
    ["raw beef", "raw"],
    ["getrocknete Tomaten", "dried"],
    ["dried oregano", "dried"],
  ]

  for (const [text, expected] of cases) {
    it(`"${text}" states ${expected}`, () => {
      expect(statedPreparation(text)).toBe(expected)
    })
  }

  it("reads a preparation as a WORD, never as a syllable inside a compound", () => {
    // The compound-head rule the marker tables use would call these cooked. A preparation is
    // claimed by a word: "Bratwurst" is a sausage, "Backpulver" is a raising agent.
    expect(statedPreparation("Bratwurst")).toBe("unknown")
    expect(statedPreparation("Backpulver")).toBe("unknown")
    expect(statedPreparation("Backofen")).toBe("unknown")
  })
})

describe("an unevidenced transformation is refused, an evidenced one is honoured", () => {
  it("refuses a 'cooked' claim the ingredient text does not support", () => {
    // The exact production failure, in one assertion.
    expect(reconcileState("cooked", "Nudeln")).toBe("unknown")
    expect(reconcileState("cooked", "Reis")).toBe("unknown")
    expect(reconcileState("cooked", "schwarze Bohnen")).toBe("unknown")
    expect(reconcileState("cooked", "Rinderhackfleisch")).toBe("unknown")
  })

  it("refuses an unevidenced 'dried' claim for the same reason", () => {
    expect(reconcileState("dried", "Tomaten")).toBe("unknown")
  })

  it("lets an untransformed claim through — an unqualified ingredient is bought as it is", () => {
    expect(reconcileState("raw", "Tomaten")).toBe("raw")
    expect(reconcileState("raw", "Rinderhackfleisch")).toBe("raw")
    expect(reconcileState("unknown", "Nudeln")).toBe("unknown")
  })

  it("honours an explicit preparation, overriding whatever the model claimed", () => {
    expect(reconcileState("raw", "gekochter Reis")).toBe("cooked")
    expect(reconcileState("unknown", "vorgekochte Nudeln")).toBe("cooked")
    expect(reconcileState("cooked", "rohes Hackfleisch")).toBe("raw")
    expect(reconcileState("raw", "getrocknete Tomaten")).toBe("dried")
  })

  it("is stable: the same text and claim always give the same state", () => {
    // Materially different states can no longer alternate for an unchanged ingredient, which is
    // the property the production instability violated.
    for (const claimed of ["raw", "cooked", "dried", "unknown"] as FoodState[]) {
      const answers = new Set(Array.from({ length: 10 }, () => reconcileState(claimed, "Nudeln")))
      expect(answers.size, `claimed=${claimed}`).toBe(1)
    }
  })
})

describe("through the classifier, with the model answering inconsistently", () => {
  it("a later cooking step cannot reach the classifier at all", async () => {
    // Structural, not merely a rule: NormalizerInput carries foodName and unitName and nothing
    // else, so "Nudeln nach Packungsanweisung kochen" is not in the prompt to be misread.
    let prompt = ""
    vi.stubGlobal("fetch", vi.fn(async (_u: unknown, init?: { body?: string }) => {
      prompt = String(JSON.parse(init?.body ?? "{}").messages?.[0]?.content ?? "")
      return CHAT(reply(1, { 0: { canonicalGerman: "Nudeln", canonicalEnglish: "pasta" } }))
    }))
    await normalizeIngredients([ing(0, "Nudeln")])
    expect(prompt).toContain("Nudeln")
    expect(prompt).not.toMatch(/kochen|Packungsanweisung|instruction/i)
  })

  it("normalizes an unsupported 'cooked' claim to unknown", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      CHAT(reply(1, { 0: { canonicalGerman: "Nudeln", canonicalEnglish: "pasta", state: "cooked" } }))))
    const [c] = await normalizeIngredients([ing(0, "Nudeln")])
    expect(c.state).toBe("unknown")
  })

  it("keeps an explicitly cooked ingredient cooked", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      CHAT(reply(1, { 0: { canonicalGerman: "Nudeln, gekocht", canonicalEnglish: "cooked pasta", state: "cooked" } }))))
    const [c] = await normalizeIngredients([ing(0, "gekochte Nudeln")])
    expect(c.state).toBe("cooked")
  })

  it("asks the model at temperature 0", async () => {
    let body: Record<string, unknown> = {}
    vi.stubGlobal("fetch", vi.fn(async (_u: unknown, init?: { body?: string }) => {
      body = JSON.parse(init?.body ?? "{}")
      return CHAT(reply(1))
    }))
    await normalizeIngredients([ing(0, "Nudeln")])
    expect(body.temperature).toBe(0)
  })

  it("gives the same answer on every run even when the model alternates", async () => {
    // The model is made to flip deliberately: cooked, then raw, then cooked… Without the cache and
    // the reconciliation this is exactly the production behaviour.
    let call = 0
    vi.stubGlobal("fetch", vi.fn(async () => {
      call++
      const state = call % 2 === 1 ? "cooked" : "raw"
      return CHAT(reply(1, { 0: { canonicalGerman: "Nudeln", canonicalEnglish: "pasta", state } }))
    }))

    const states: string[] = []
    for (let i = 0; i < 5; i++) {
      const [c] = await normalizeIngredients([ing(0, "Nudeln")])
      states.push(c.state)
    }
    expect(new Set(states).size).toBe(1)
    expect(states[0]).toBe("unknown")
    // …and only the FIRST run cost a request; the rest were served from cache.
    expect(call).toBe(1)
  })
})

describe("the classification cache", () => {
  it("issues no request at all when every ingredient is already cached", async () => {
    const fetchSpy = vi.fn(async () => CHAT(reply(2)))
    vi.stubGlobal("fetch", fetchSpy)
    const inputs = [ing(0, "Olivenöl"), ing(1, "Tomate")]

    await normalizeIngredients(inputs)
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    const again = await normalizeIngredients(inputs)
    expect(fetchSpy).toHaveBeenCalledTimes(1) // unchanged — nothing was asked
    expect(again.every((c) => c.fromCache)).toBe(true)
  })

  it("asks only about the ingredients it does not know, renumbered so index validation holds", async () => {
    let asked: string[] = []
    vi.stubGlobal("fetch", vi.fn(async (_u: unknown, init?: { body?: string }) => {
      const prompt = String(JSON.parse(init?.body ?? "{}").messages?.[0]?.content ?? "")
      asked = [...prompt.matchAll(/name="([^"]+)"/g)].map((m) => m[1])
      return CHAT(reply(asked.length, Object.fromEntries(
        asked.map((name, i) => [i, { canonicalGerman: name, canonicalEnglish: name }]))))
    }))

    await normalizeIngredients([ing(0, "Olivenöl")])
    expect(asked).toEqual(["Olivenöl"])

    // Second recipe shares one ingredient; only the new one is asked about, and it arrives at
    // index 0 of the sub-batch rather than its recipe position.
    const out = await normalizeIngredients([ing(0, "Olivenöl"), ing(1, "Tomate")])
    expect(asked).toEqual(["Tomate"])
    expect(out.map((c) => c.index)).toEqual([0, 1])
    expect(out[0].fromCache).toBe(true)
    expect(out[1].fromCache).toBeFalsy()
    expect(out[1].canonicalGerman).toBe("Tomate")
  })

  it("keys the semantic input, not the amount — which never reaches the classifier", () => {
    // NormalizerInput has no amount field at all; the unit does reach the prompt, so it is keyed.
    expect(classificationCacheKey(ing(0, "Nudeln"))).toBe(classificationCacheKey(ing(7, "Nudeln")))
    expect(classificationCacheKey(ing(0, "Nudeln"))).not.toBe(classificationCacheKey(ing(0, "Nudeln", "Stück")))
    expect(classificationCacheKey(ing(0, "Nudeln"))).not.toBe(classificationCacheKey(ing(0, "Reis")))
  })

  it("retires stored interpretations when the model changes", () => {
    const before = classificationCacheKey(ing(0, "Nudeln"))
    const previous = config.llm.model
    try {
      config.llm.model = "some-other-model"
      expect(classificationCacheKey(ing(0, "Nudeln"))).not.toBe(before)
    } finally {
      config.llm.model = previous
    }
  })

  it("never stores a deterministic fallback — one bad minute must not become permanent", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not json at all", { status: 500 })))
    const [failed] = await normalizeIngredients([ing(0, "Nudeln")])
    expect(failed.llmClassified).toBe(false)
    expect(getCachedClassification(classificationCacheKey(ing(0, "Nudeln")))).toBeUndefined()

    // A later healthy run classifies it properly and IS stored.
    vi.stubGlobal("fetch", vi.fn(async () =>
      CHAT(reply(1, { 0: { canonicalGerman: "Nudeln", canonicalEnglish: "pasta" } }))))
    const [ok] = await normalizeIngredients([ing(0, "Nudeln")])
    expect(ok.llmClassified).toBe(true)
    expect(getCachedClassification(classificationCacheKey(ing(0, "Nudeln")))).toBeDefined()
  })

  it("re-classifies rather than trusting a row it cannot read", async () => {
    setCachedClassification(classificationCacheKey(ing(0, "Nudeln")), { nonsense: true })
    const fetchSpy = vi.fn(async () => CHAT(reply(1, { 0: { canonicalGerman: "Nudeln", canonicalEnglish: "pasta" } })))
    vi.stubGlobal("fetch", fetchSpy)
    const [c] = await normalizeIngredients([ing(0, "Nudeln")])
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(c.canonicalEnglish).toBe("pasta")
  })

  it("is not coupled to the nutrition caches", () => {
    // Its own table: clearing it must not require, or imply, clearing provider matches.
    setCachedClassification("standalone-key", { canonicalGerman: "x", canonicalEnglish: "x", state: "raw", foodType: "simple", attributes: {} })
    expect(getCachedClassification("standalone-key")).toBeDefined()
    clearLlmCache()
    expect(getCachedClassification("standalone-key")).toBeUndefined()
  })
})

describe("the validation cases, end to end through the classifier", () => {
  /** Runs one ingredient with the model claiming `claimed`, and returns the settled state. */
  async function settle(foodName: string, claimed: string): Promise<FoodState> {
    clearLlmCache()
    vi.stubGlobal("fetch", vi.fn(async () =>
      CHAT(reply(1, { 0: { canonicalGerman: foodName, canonicalEnglish: foodName, state: claimed } }))))
    const [c] = await normalizeIngredients([ing(0, foodName)])
    return c.state
  }

  // [ingredient, what the model claims, what must be recorded]
  const CASES: [string, string, FoodState][] = [
    ["Nudeln", "cooked", "unknown"],                  // plain dry pasta
    ["gekochte Nudeln", "cooked", "cooked"],          // explicitly cooked pasta
    ["Reis", "cooked", "unknown"],                    // plain rice
    ["gekochter Reis", "cooked", "cooked"],           // explicitly cooked rice
    ["schwarze Bohnen", "cooked", "unknown"],         // plain dry beans
    ["Bohnen aus der Dose", "cooked", "unknown"],     // canned beans — canned is preservation, not preparation
    ["Rinderhackfleisch", "cooked", "unknown"],       // raw meat
    ["Rinderhackfleisch", "raw", "raw"],              // …and an untransformed claim survives
    ["gebratenes Hackfleisch", "raw", "cooked"],      // cooked meat, explicitly stated
    ["frischer Koriander", "dried", "unknown"],       // fresh herbs must not become dried
    ["getrockneter Oregano", "raw", "dried"],         // dried herbs
    ["TK-Spinat", "cooked", "unknown"],               // frozen vegetables — frozen is preservation
    ["getrocknete Tomaten", "raw", "dried"],          // dried tomatoes
    ["Zutat", "cooked", "unknown"],                   // unknown ingredient, no safe assumption
  ]

  for (const [foodName, claimed, expected] of CASES) {
    it(`"${foodName}" with the model claiming "${claimed}" settles on ${expected}`, async () => {
      expect(await settle(foodName, claimed)).toBe(expected)
    })
  }

  it("keeps canned and frozen on the preservation axis, untouched by the state rule", async () => {
    clearLlmCache()
    vi.stubGlobal("fetch", vi.fn(async () => CHAT(reply(2, {
      0: { canonicalGerman: "Bohnen aus der Dose", canonicalEnglish: "canned beans", state: "cooked", preservation: "canned" },
      1: { canonicalGerman: "TK-Spinat", canonicalEnglish: "frozen spinach", state: "cooked", preservation: "frozen" },
    }))))
    const [beans, spinach] = await normalizeIngredients([ing(0, "Bohnen aus der Dose"), ing(1, "TK-Spinat")])
    expect(beans.attributes.preservation).toBe("canned")
    expect(spinach.attributes.preservation).toBe("frozen")
    // The preparation claim is still refused — neither text says anything was cooked.
    expect(beans.state).toBe("unknown")
    expect(spinach.state).toBe("unknown")
  })
})
