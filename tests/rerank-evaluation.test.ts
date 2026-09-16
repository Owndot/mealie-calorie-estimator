import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest"
import { config } from "../src/config.js"
import { initCache, clearLlmCache, __clearProviderCachesForTests } from "../src/utils/cache.js"
import { BlsProvider } from "../src/services/providers/bls-provider.js"
import { inferAttributesFromName } from "../src/services/providers/food-semantics.js"
import { UNKNOWN_ATTRIBUTES, type ProviderMatch } from "../src/types.js"

/**
 * End-to-end evaluation of LLM-assisted reranking against the REAL BLS database, with the model's
 * reply stubbed deterministically. Two things are under test, and the second matters more:
 *
 *   1. when the model is asked, does the pipeline honour its answer and record the provenance?
 *   2. when is it asked at all — and does declining leave the deterministic outcome untouched?
 *
 * The stub records every prompt, so each case can assert what the model was actually shown: which
 * candidates reached it, and, just as importantly, which ones the hard gates had already removed.
 */
beforeAll(async () => {
  await initCache()
})

interface Stub { calls: number; prompts: string[] }

/** `reply` receives the candidate list parsed back out of the prompt, so a stub can "choose" by name. */
function stubLlm(reply: (candidates: string[]) => string): Stub {
  const state: Stub = { calls: 0, prompts: [] }
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: { body?: string }) => {
    state.calls++
    const prompt = JSON.parse(init.body!).messages[0].content as string
    state.prompts.push(prompt)
    const candidates = prompt.split("CANDIDATES\n")[1].split("\n\nRULES")[0].split("\n")
    return new Response(JSON.stringify({ choices: [{ message: { content: reply(candidates) } }] }), {
      status: 200, headers: { "content-type": "application/json" },
    })
  }))
  return state
}

/** Picks the first offered candidate whose line matches `pattern`, or NONE when none does. */
const choose = (pattern: RegExp) => (candidates: string[]): string => {
  const i = candidates.findIndex((c) => pattern.test(c))
  return i === -1
    ? '{"selected":null,"confidence":0.9,"reason":"no suitable candidate"}'
    : `{"selected":${i + 1},"confidence":0.9,"reason":"matches the ingredient"}`
}
const declineAlways = () => '{"selected":null,"confidence":0.95,"reason":"nothing is the same food"}'

beforeEach(() => {
  config.llm.enabled = true
  config.llm.apiKey = "test-key"
  config.llm.rerankEnabled = true
  config.llm.rerankMinConfidence = 0.6
  config.llm.rerankMaxCandidates = 8
  clearLlmCache()
  __clearProviderCachesForTests()
  vi.restoreAllMocks()
})

afterEach(() => {
  config.llm.enabled = false
  config.llm.apiKey = ""
})

const provider = new BlsProvider()

async function lookup(name: string, coreDe: string, en = name, state = "unknown"): Promise<ProviderMatch | null> {
  const attrs = { ...UNKNOWN_ATTRIBUTES, ...inferAttributesFromName(name) }
  return provider.lookup({
    foodName: en, structuredName: name, canonicalGerman: name, brand: null, category: null,
    state, foodType: "simple", coreFoodGerman: coreDe, coreFoodEnglish: en, route: "generic",
    attributes: attrs, evidence: { german: true, english: true, core: true, brand: false },
  } as never)
}

describe("the reranker can only improve on records retrieval already found", () => {
  it("Petersilie: reaches the LEAF record, which deterministic scoring cannot see at all", async () => {
    // "Petersilie" is the compound PREFIX of "Petersilienblatt", a direction the precision-tuned
    // scorer deliberately does not match (it is how "Salz" once reached "Salzstangen"). Recall is
    // widened only for reranking, so the leaf becomes selectable without ever becoming acceptable
    // on its own.
    const s = stubLlm(choose(/Petersilienblatt/))
    const m = await lookup("Petersilie", "Petersilie")
    expect(s.calls).toBe(1)
    expect(s.prompts[0]).toMatch(/Petersilienblatt/)
    expect(m?.productName).toMatch(/Petersilienblatt/)
    expect(m?.kcalPer100g ?? m?.nutrients.kcalPer100g).toBeLessThan(60) // the herb, not the 76 kcal root
    expect(m?.llmReranked).toBe(true)
    expect(m?.provider).toBe("bls") // nutrients still come FROM the database
    expect(m?.providerId).toMatch(/^G/)
  })

  it("Mehl: answers NONE rather than inventing a grain, and the ingredient stays unresolved", async () => {
    // BLS has no generic flour. Every candidate names a base the ingredient never did, so NONE is
    // the only correct answer — and NONE must leave BLS reporting a miss so the provider chain
    // continues.
    const s = stubLlm(declineAlways)
    const m = await lookup("Mehl", "Mehl", "flour")
    expect(s.calls).toBe(1)
    expect(m).toBeNull()
  })

  it("Mehl: even a model that tries to pick lupin flour cannot beat the confidence gate", async () => {
    stubLlm(() => '{"selected":1,"confidence":0.4,"reason":"closest available"}')
    expect(await lookup("Mehl", "Mehl", "flour")).toBeNull()
  })

  it("Thunfisch a. d. Dose: prefers the canned record the score alone could not reach", async () => {
    const s = stubLlm(choose(/Konserve/))
    const m = await lookup("Thunfisch a. d. Dose", "Thunfisch", "canned tuna")
    expect(s.calls).toBe(1)
    expect(m?.productName).toMatch(/Konserve/)
    expect(m?.llmReranked).toBe(true)
  })

  it("Erbsen: the green and the dry record are both offered, so the choice is not made by score order", async () => {
    const s = stubLlm(choose(/Erbse gr/))
    const m = await lookup("Erbsen", "Erbse", "peas")
    expect(s.calls).toBe(1)
    expect(s.prompts[0]).toMatch(/Erbse reif/)
    expect(s.prompts[0]).toMatch(/Erbse gr/)
    expect(m?.productName).toMatch(/Erbse gr/)
    expect(m?.nutrients.kcalPer100g).toBeLessThan(200)
  })

  it("Erbsen: the deep-fried snack record was removed by the gates and is never offered", async () => {
    // Defence in depth: the model must not even be given the chance to pick Backerbsen.
    const s = stubLlm(declineAlways)
    await lookup("Erbsen", "Erbse", "peas")
    expect(s.prompts[0] ?? "").not.toMatch(/Backerbsen/)
  })
})

describe("confident deterministic matches never reach the model", () => {
  // With the preparation state the whole-recipe normalizer actually assigns — raw rice is
  // classified "raw", which is itself decisive evidence against the cooked variants.
  const cases: [string, string, string, string][] = [
    ["Basmati-Reis", "Reis", "basmati rice", "raw"],
    ["Kidneybohnen a. d. Dose", "Kidneybohne", "canned kidney beans", "unknown"],
    ["Zwiebel", "Zwiebel", "onion", "raw"],
    ["Olivenöl", "Olivenöl", "olive oil", "unknown"],
    ["Tomate", "Tomate", "tomato", "raw"],
  ]

  it.each(cases)("%s resolves without an LLM call", async (name, core, en, state) => {
    const s = stubLlm(() => { throw new Error("the reranker must not be called here") })
    const m = await lookup(name, core, en, state)
    expect(m, name).not.toBeNull()
    expect(s.calls, `${name} -> ${m?.productName}`).toBe(0)
    expect(m?.llmReranked ?? false).toBe(false)
  })

  it("keeps the canned kidney-bean record chosen deterministically", async () => {
    stubLlm(() => { throw new Error("must not be called") })
    const m = await lookup("Kidneybohnen a. d. Dose", "Kidneybohne", "canned kidney beans")
    expect(m?.productName).toMatch(/Konserve/)
    expect(m?.nutrients.kcalPer100g).toBeLessThan(200)
  })
})

describe("a declining model leaves every gate-enforced outcome exactly as it was", () => {
  const cases: [string, string, string, RegExp][] = [
    ["Koriander", "Koriander", "coriander", /./],
    ["Gurkenwasser", "Gurke", "cucumber water", /./],
    ["Knoblauchgewürz", "Knoblauch", "garlic seasoning", /./],
  ]

  it.each(cases)("%s stays unresolved in BLS", async (name, core, en) => {
    stubLlm(declineAlways)
    expect(await lookup(name, core, en), name).toBeNull()
  })

  it("a model that tries to pick raw garlic for a seasoning cannot, because it is never offered", async () => {
    const s = stubLlm(choose(/Knoblauch roh/))
    const m = await lookup("Knoblauchgewürz", "Knoblauch", "garlic seasoning")
    expect(s.prompts[0] ?? "").not.toMatch(/Knoblauch roh/)
    expect(m?.productName ?? "").not.toMatch(/Knoblauch roh/)
  })

  it("rice noodles are never even offered for pasta, so the model cannot choose them", async () => {
    // "Reisnudeln" is removed by the sub-variety gate before the candidate set is built.
    const s = stubLlm(choose(/Reisnudeln/))
    const m = await lookup("Nudeln", "Nudeln", "pasta", "raw")
    expect(s.prompts[0] ?? "").not.toMatch(/Reisnudeln/)
    expect(m?.productName).toMatch(/Teigwaren/)
  })

  it("sweet mustard is offered but declining leaves the neutral record in place", async () => {
    // BLS's four mustards are three neutral ones at 111 kcal and "Senf süß" at 177. Asking is
    // legitimate — they are genuinely different foods — but the prompt forbids adding sweetening,
    // and a decline must leave the deterministic answer untouched.
    const s = stubLlm(declineAlways)
    const m = await lookup("Senf", "Senf", "mustard")
    expect(s.prompts[0]).toMatch(/Senf süß/)
    expect(m?.productName).not.toMatch(/süß/)
    expect(m?.kcalPer100g ?? m?.nutrients.kcalPer100g).toBeLessThan(140)
  })

  it("a model that picks sweet mustard anyway is honoured — and that is why the prompt forbids it", async () => {
    // Recorded deliberately: the reranker CAN override a correct deterministic answer. The safety
    // property is not "the model cannot be wrong", it is that it can only ever choose among records
    // the gates approved, and that its choice is marked as model-assisted in provenance.
    const s = stubLlm(choose(/Senf süß/))
    const m = await lookup("Senf", "Senf", "mustard")
    expect(s.calls).toBe(1)
    expect(m?.llmReranked).toBe(true)
    expect(m?.rerankReason).toBeTruthy()
  })

  it("unqualified pasta is asked about dry vs fresh, and declining keeps the dry record", async () => {
    const s = stubLlm(declineAlways)
    const m = await lookup("Nudeln", "Nudeln", "pasta", "raw")
    expect(s.prompts[0]).toMatch(/Frischteigwaren/)
    expect(m?.productName).toBe("Teigwaren eifrei, roh")
  })
})

describe("reranking is off unless explicitly available", () => {
  it("makes no call and changes nothing when the LLM is disabled", async () => {
    const s = stubLlm(choose(/Petersilienblatt/))
    config.llm.enabled = false
    const m = await lookup("Petersilie", "Petersilie")
    expect(s.calls).toBe(0)
    expect(m).toBeNull() // exactly the pre-rerank behaviour
  })
})
