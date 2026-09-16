import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest"
import { config } from "../../src/config.js"
import { initCache, clearLlmCache } from "../../src/utils/cache.js"
import { parseRerankReply, rerankCandidates, type RerankCandidate, type RerankQuery } from "../../src/services/providers/candidate-rerank.js"
import { rerankTrigger, type TriggerCandidate } from "../../src/services/providers/bls-provider.js"
import { UNKNOWN_ATTRIBUTES, type FoodForm, type FoodPreservation, type FoodState } from "../../src/types.js"

/**
 * The reranker is a SEMANTIC JUDGE over records retrieval already found — never a source of
 * nutrition, and never able to reach a record the hard gates removed. These tests pin the two
 * properties that make that safe: NONE is a first-class answer, and every malformed, hallucinated,
 * slow or low-confidence reply degrades to exactly the behaviour there would be with no LLM at all.
 *
 * Every LLM response here is a deterministic stub; no test in this file makes a network call.
 */
beforeAll(async () => {
  await initCache()
})

const CANDIDATES: RerankCandidate[] = [
  { providerId: "G670100", productName: "Wurzelpetersilie roh", kcalPer100g: 76, form: "unknown", preservation: "fresh", score: 22 },
  { providerId: "G250100", productName: "Petersilienblatt roh", kcalPer100g: 33, form: "leaf", preservation: "fresh", score: 15 },
]

const QUERY: RerankQuery = {
  provider: "bls", structuredName: "Petersilie", canonicalGerman: "Petersilie",
  canonicalEnglish: "parsley", coreFood: "Petersilie", state: "unknown", attributes: UNKNOWN_ATTRIBUTES,
}

/** Serves one canned assistant message, and counts how many times the endpoint was called. */
function stubLlm(content: string | (() => Promise<Response>)): { calls: number } {
  const state = { calls: 0 }
  vi.stubGlobal("fetch", vi.fn(async () => {
    state.calls++
    if (typeof content !== "string") return content()
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200, headers: { "content-type": "application/json" },
    })
  }))
  return state
}

beforeEach(() => {
  config.llm.enabled = true
  config.llm.apiKey = "test-key"
  config.llm.rerankEnabled = true
  config.llm.rerankMinConfidence = 0.6
  config.llm.rerankMaxCandidates = 8
  clearLlmCache()
  vi.restoreAllMocks()
})

afterEach(() => {
  config.llm.enabled = false
  config.llm.apiKey = ""
})

describe("parsing is strict — anything unusable means NONE", () => {
  it("accepts a well-formed selection and maps it to the candidate's own id", () => {
    const d = parseRerankReply('{"selected":2,"confidence":0.9,"reason":"leaf, not root"}', CANDIDATES)
    expect(d).toEqual({ providerId: "G250100", confidence: 0.9, reason: "leaf, not root" })
  })

  it("treats null, \"NONE\" and a missing selection as an explicit NONE verdict", () => {
    for (const body of ['{"selected":null,"confidence":0.8,"reason":"no generic record"}',
                        '{"selected":"NONE","confidence":0.8,"reason":"x"}',
                        '{"confidence":0.8,"reason":"x"}']) {
      expect(parseRerankReply(body, CANDIDATES)?.providerId, body).toBeNull()
    }
  })

  it("tolerates prose or a markdown fence around the JSON", () => {
    const d = parseRerankReply('Sure!\n```json\n{"selected":1,"confidence":0.7,"reason":"ok"}\n```', CANDIDATES)
    expect(d?.providerId).toBe("G670100")
  })

  it("rejects a candidate number that was never offered", () => {
    // The whole reason candidates are numbered 1..N rather than addressed by real database codes:
    // an invented index cannot resolve to a record, whereas an invented "G123456" might look real.
    expect(parseRerankReply('{"selected":7,"confidence":0.99,"reason":"x"}', CANDIDATES)).toBeNull()
    expect(parseRerankReply('{"selected":0,"confidence":0.99,"reason":"x"}', CANDIDATES)).toBeNull()
    expect(parseRerankReply('{"selected":"G999999","confidence":0.99,"reason":"x"}', CANDIDATES)).toBeNull()
  })

  it("rejects malformed JSON and a missing/non-numeric confidence", () => {
    expect(parseRerankReply("not json at all", CANDIDATES)).toBeNull()
    expect(parseRerankReply('{"selected":1,"reason":"x"}', CANDIDATES)).toBeNull()
    expect(parseRerankReply('{"selected":1,"confidence":"high","reason":"x"}', CANDIDATES)).toBeNull()
  })

  it("clamps an out-of-range confidence rather than trusting it", () => {
    expect(parseRerankReply('{"selected":1,"confidence":4,"reason":"x"}', CANDIDATES)?.confidence).toBe(1)
    expect(parseRerankReply('{"selected":1,"confidence":-2,"reason":"x"}', CANDIDATES)?.confidence).toBe(0)
  })
})

describe("every failure mode degrades to the deterministic path", () => {
  it("returns null when the model declines", async () => {
    stubLlm('{"selected":null,"confidence":0.95,"reason":"no generic flour in the set"}')
    const d = await rerankCandidates(QUERY, CANDIDATES)
    expect(d?.providerId).toBeNull()
  })

  it("returns null on an HTTP error", async () => {
    stubLlm(async () => new Response("nope", { status: 500 }))
    expect(await rerankCandidates(QUERY, CANDIDATES)).toBeNull()
  })

  it("returns null on a network failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNRESET") }))
    expect(await rerankCandidates(QUERY, CANDIDATES)).toBeNull()
  })

  it("returns null on a non-JSON body and on an envelope with no content", async () => {
    stubLlm(async () => new Response("<html>", { status: 200 }))
    expect(await rerankCandidates(QUERY, CANDIDATES)).toBeNull()
    stubLlm(async () => new Response(JSON.stringify({ choices: [] }), { status: 200, headers: { "content-type": "application/json" } }))
    expect(await rerankCandidates(QUERY, CANDIDATES)).toBeNull()
  })

  it("returns null when confidence is below the threshold", async () => {
    stubLlm('{"selected":2,"confidence":0.3,"reason":"guessing"}')
    expect(await rerankCandidates(QUERY, CANDIDATES)).toBeNull()
  })

  it("never calls the endpoint when reranking is disabled or unconfigured", async () => {
    const off = stubLlm('{"selected":1,"confidence":0.9,"reason":"x"}')
    config.llm.rerankEnabled = false
    expect(await rerankCandidates(QUERY, CANDIDATES)).toBeNull()
    config.llm.rerankEnabled = true
    config.llm.apiKey = ""
    expect(await rerankCandidates(QUERY, CANDIDATES)).toBeNull()
    expect(off.calls).toBe(0)
  })

  it("never calls the endpoint with an empty candidate set", async () => {
    const s = stubLlm('{"selected":1,"confidence":0.9,"reason":"x"}')
    expect(await rerankCandidates(QUERY, [])).toBeNull()
    expect(s.calls).toBe(0)
  })
})

describe("decisions are cached per ingredient AND candidate set", () => {
  it("asks once for the same question", async () => {
    const s = stubLlm('{"selected":2,"confidence":0.9,"reason":"leaf"}')
    const first = await rerankCandidates(QUERY, CANDIDATES)
    const second = await rerankCandidates(QUERY, CANDIDATES)
    expect(first?.providerId).toBe("G250100")
    expect(second?.providerId).toBe("G250100")
    expect(s.calls).toBe(1)
  })

  it("caches a NONE verdict too — it is a real answer, not a failure", async () => {
    const s = stubLlm('{"selected":null,"confidence":0.9,"reason":"nothing fits"}')
    await rerankCandidates(QUERY, CANDIDATES)
    await rerankCandidates(QUERY, CANDIDATES)
    expect(s.calls).toBe(1)
  })

  it("asks again when the candidate SET changes", async () => {
    // A stored judgement is about the options that were offered. Change retrieval and the old
    // answer is about a different question.
    const s = stubLlm('{"selected":1,"confidence":0.9,"reason":"x"}')
    await rerankCandidates(QUERY, CANDIDATES)
    await rerankCandidates(QUERY, [...CANDIDATES, { providerId: "G670400", productName: "Wurzelpetersilie getrocknet", kcalPer100g: 339, form: "unknown", preservation: "dried", score: 12 }])
    expect(s.calls).toBe(2)
  })

  it("asks again when the ingredient's attributes change", async () => {
    const s = stubLlm('{"selected":1,"confidence":0.9,"reason":"x"}')
    await rerankCandidates(QUERY, CANDIDATES)
    await rerankCandidates({ ...QUERY, attributes: { form: "leaf", preservation: "unknown", fatPercent: null } }, CANDIDATES)
    expect(s.calls).toBe(2)
  })
})

describe("the trigger decides when a call is worth making at all", () => {
  // Minimal stand-ins for a scored BLS record: the trigger reads the code, the energy, and the
  // attribute/state evidence it uses to tell "genuinely ambiguous" from "already decided".
  const scored = (blsCode: string, score: number, kcal: number | null, over: Partial<{ preservation: FoodPreservation; form: FoodForm; inferredState: FoodState; identityTokens: string[] }> = {}): TriggerCandidate => ({
    score,
    record: {
      blsCode,
      nutrients: { kcalPer100g: kcal },
      attributes: { form: over.form ?? "unknown", preservation: over.preservation ?? "unknown", fatPercent: null },
      inferredState: over.inferredState ?? "unknown",
      // Distinct by default: a rival that is merely a PREPARATION variant of the winner shares its
      // identity and is deliberately not treated as ambiguity, so these stubs must differ.
      identityTokens: over.identityTokens ?? [blsCode],
    },
  })
  const pool = (...items: TriggerCandidate[]) => new Map(items.map((i) => [i.record.blsCode, i]))

  it("fires when gates approved candidates but none scored high enough to accept", () => {
    expect(rerankTrigger(null, pool(scored("A", 22, 76)))).toBe("no-acceptable-candidate")
  })

  it("does not fire when there is nothing to judge", () => {
    expect(rerankTrigger(null, pool())).toBeNull()
  })

  it("fires when a near-tied rival would change the answer materially", () => {
    // Canned vs dry beans: two points apart, 2.5x the calories.
    const top = scored("dry", 75, 316)
    expect(rerankTrigger(top as never, pool(top, scored("canned", 74, 128)))).toBe("material-rival")
  })

  it("does not fire for a near-tied rival with the same nutrition", () => {
    const top = scored("a", 75, 111)
    expect(rerankTrigger(top as never, pool(top, scored("b", 74, 111)))).toBeNull()
  })

  it("does not fire when a candidate's energy is unknown — that is not evidence of ambiguity", () => {
    const top = scored("a", 75, 111)
    expect(rerankTrigger(top as never, pool(top, scored("b", 74, null)))).toBeNull()
  })
})
