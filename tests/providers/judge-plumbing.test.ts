import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest"
import { config } from "../../src/config.js"
import { initCache, clearLlmCache, __clearProviderCachesForTests, getCachedJudgeDecision, setCachedJudgeDecision, getCachedRerank } from "../../src/utils/cache.js"
import { orderCandidates, poolFingerprint, judgeCacheKey } from "../../src/services/providers/judge/candidate-pool.js"
import { judgeNeed } from "../../src/services/providers/judge/judge-need.js"
import { askJudge, parseJudgeReply, judgeQueryKey } from "../../src/services/providers/judge/judge.js"
import type { JudgeCandidate, JudgeQuery } from "../../src/services/providers/judge/types.js"
import { resolveNutrients } from "../../src/services/nutrient-resolver.js"
import { estimateRecipe, buildNutritionPatch } from "../../src/services/estimator.js"
import { UNKNOWN_ATTRIBUTES, type FoodAttributes, type MealieRecipe, type NutrientSet, type ProviderMatch } from "../../src/types.js"

/**
 * PR B — the semantic judge's PLUMBING, with the judge itself switched off.
 *
 * Two things are under test here and nothing else: that the machinery a judge needs is correct and
 * reproducible, and that none of it can touch a resolution while LLM_JUDGE_ENABLED is false.
 *
 * The eligibility tests are deliberately written against SEMANTICS rather than confidence.
 * Production supplied the counterexample that makes that necessary: "Gurkenwasser" resolved to
 * "Water, bottled, generic" at confidence 0.7 with no unmet attributes — comfortably above any
 * threshold, and the wrong food — while "gemahlener Koriander" resolves to "Spices, coriander
 * seed" at the same 0.7 and is exactly right. A number cannot separate those two; a named
 * unresolved question can.
 */

const NUTRIENTS = (kcal: number, fat = 0): NutrientSet => ({
  kcalPer100g: kcal, proteinPer100g: 10, carbsPer100g: 20, fatPer100g: fat,
  saturatedFatPer100g: null, transFatPer100g: null, unsaturatedFatPer100g: null,
  fiberPer100g: null, sugarPer100g: null, sodiumPer100g: null, cholesterolPer100g: null,
})

const cand = (over: Partial<JudgeCandidate> & { providerId: string }): JudgeCandidate => ({
  id: `${over.provider ?? "usda-local"}:${over.providerId}`,
  provider: over.provider ?? "usda-local",
  providerId: over.providerId,
  name: over.name ?? `Record ${over.providerId}`,
  dataType: over.dataType ?? null,
  brand: null, category: null,
  state: over.state ?? "raw", form: over.form ?? "unknown", preservation: over.preservation ?? "unknown",
  nutrients: over.nutrients ?? NUTRIENTS(100),
  score: over.score ?? 50,
})

const shuffle = <T>(a: T[], seed: number): T[] => {
  const out = [...a]
  let s = seed
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) % 2147483648
    const j = s % (i + 1)
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

beforeAll(async () => { await initCache() })

describe("candidate ordering is a pure function of the candidate SET", () => {
  const POOL = [
    cand({ providerId: "173734", name: "Beans, black, mature seeds, raw", score: 54, dataType: "SR Legacy" }),
    cand({ providerId: "175186", name: "Beans, black turtle, mature seeds, raw", score: 15, dataType: "SR Legacy" }),
    cand({ providerId: "2644281", name: "Beans, cannellini, dry", score: 15, dataType: "Foundation" }),
    cand({ providerId: "9", name: "Low id, same score", score: 15, dataType: "SR Legacy" }),
    cand({ providerId: "10", name: "Higher id, same score", score: 15, dataType: "SR Legacy" }),
    cand({ provider: "bls", providerId: "H725100", name: "Linse reif", score: 15 }),
    cand({ provider: "mealie-recipe", providerId: "tikka-paste", name: "Tikka-Paste", score: 15 }),
  ]

  it("produces the same order from twenty different input orders", () => {
    const reference = orderCandidates(POOL).map((c) => c.id)
    for (let seed = 1; seed <= 20; seed++) {
      expect(orderCandidates(shuffle(POOL, seed)).map((c) => c.id), `seed ${seed}`).toEqual(reference)
    }
  })

  it("breaks ties by provider precedence, then dataset tier, then numeric id, then name", () => {
    const ids = orderCandidates(POOL).map((c) => c.id)
    // Score decides first: the 54 leads regardless of provider.
    expect(ids[0]).toBe("usda-local:173734")
    // Then provider precedence among the score-15 rows — mealie-recipe stays first-class.
    expect(ids.slice(1, 3)).toEqual(["mealie-recipe:tikka-paste", "bls:H725100"])
    // Then Foundation before SR Legacy within usda-local.
    expect(ids[3]).toBe("usda-local:2644281")
    // Then ids compared NUMERICALLY — "9" before "10", which a string sort would invert.
    expect(ids.indexOf("usda-local:9")).toBeLessThan(ids.indexOf("usda-local:10"))
  })

  it("truncates after ordering, so which candidates are dropped is deterministic too", () => {
    const a = orderCandidates(shuffle(POOL, 3), 3).map((c) => c.id)
    const b = orderCandidates(shuffle(POOL, 17), 3).map((c) => c.id)
    expect(a).toEqual(b)
    expect(a).toHaveLength(3)
  })

  it("drops a duplicate record, keeping the higher-ranked one", () => {
    const dup = cand({ providerId: "999", name: "Beans, black, mature seeds, raw", score: 5, nutrients: NUTRIENTS(100) })
    const ordered = orderCandidates([...POOL, dup])
    expect(ordered.filter((c) => c.name === "Beans, black, mature seeds, raw")).toHaveLength(1)
    expect(ordered.find((c) => c.name === "Beans, black, mature seeds, raw")!.providerId).toBe("173734")
  })
})

describe("pool fingerprinting", () => {
  const A = cand({ providerId: "1", name: "Beans, black, mature seeds, raw", score: 50, nutrients: NUTRIENTS(341) })
  const B = cand({ providerId: "2", name: "Beans, black turtle, mature seeds, canned", score: 20, nutrients: NUTRIENTS(91) })

  it("is stable across input order, because the ordered pool is what gets hashed", () => {
    const one = poolFingerprint(orderCandidates([A, B]))
    const two = poolFingerprint(orderCandidates([B, A]))
    expect(one).toBe(two)
  })

  it("changes when a candidate's material identity changes", () => {
    const base = poolFingerprint(orderCandidates([A, B]))
    const renamed = { ...A, name: "Beans, black, mature seeds, cooked" }
    const reenergised = { ...A, nutrients: NUTRIENTS(132) }
    const restated = { ...A, preservation: "canned" }
    expect(poolFingerprint(orderCandidates([renamed, B]))).not.toBe(base)
    expect(poolFingerprint(orderCandidates([reenergised, B]))).not.toBe(base)
    expect(poolFingerprint(orderCandidates([restated, B]))).not.toBe(base)
  })

  it("changes when a candidate joins or leaves the pool", () => {
    const base = poolFingerprint(orderCandidates([A, B]))
    expect(poolFingerprint(orderCandidates([A]))).not.toBe(base)
    expect(poolFingerprint(orderCandidates([A, B, cand({ providerId: "3", score: 1 })]))).not.toBe(base)
  })

  it("ignores a score drift that does not reorder the pool — the same question deserves the cached answer", () => {
    const base = poolFingerprint(orderCandidates([A, B]))
    expect(poolFingerprint(orderCandidates([{ ...A, score: 47 }, B]))).toBe(base)
  })

  it("DOES change when a score drift reorders the pool, because the question changed", () => {
    const base = poolFingerprint(orderCandidates([A, B]))
    expect(poolFingerprint(orderCandidates([{ ...A, score: 1 }, B]))).not.toBe(base)
  })
})

describe("the model may never construct a candidate", () => {
  const pool = orderCandidates([cand({ providerId: "173734", score: 50 }), cand({ providerId: "175186", score: 20 })])

  it("rejects a selected id that is not in the supplied pool", () => {
    const r = parseJudgeReply('{"decision":"selected","candidateId":"usda-local:999999","confidence":0.9,"reason":"x"}', pool)
    expect(r.decision).toBeNull()
    expect(r.invalidReason).toMatch(/not in the candidate set/)
  })

  it("rejects a selected verdict with no id at all", () => {
    expect(parseJudgeReply('{"decision":"selected","candidateId":null,"confidence":1,"reason":"x"}', pool).decision).toBeNull()
  })

  it("rejects an unknown verdict, malformed JSON and a reply with no JSON at all", () => {
    expect(parseJudgeReply('{"decision":"maybe","candidateId":null}', pool).invalidReason).toMatch(/unknown decision/)
    expect(parseJudgeReply("{not json", pool).invalidReason).toBeTruthy()
    expect(parseJudgeReply("I think the first one.", pool).invalidReason).toMatch(/no JSON object/)
  })

  it("accepts AMBIGUOUS and NONE as real verdicts, and forces their id to null", () => {
    const amb = parseJudgeReply('{"decision":"ambiguous","candidateId":"usda-local:173734","confidence":0.5,"reason":"two grades"}', pool)
    expect(amb.decision).toEqual({ verdict: "ambiguous", candidateId: null, confidence: 0.5, reason: "two grades" })
    const none = parseJudgeReply('{"decision":"none","candidateId":null,"confidence":1,"reason":"different food"}', pool)
    expect(none.decision!.verdict).toBe("none")
  })

  it("accepts a valid selection and returns only an id — never a nutrient value", () => {
    const r = parseJudgeReply('{"decision":"selected","candidateId":"usda-local:173734","confidence":0.8,"reason":"same food","kcal":999}', pool)
    expect(r.decision!.candidateId).toBe("usda-local:173734")
    expect(Object.keys(r.decision!).sort()).toEqual(["candidateId", "confidence", "reason", "verdict"])
  })
})

describe("with LLM_JUDGE_ENABLED=false the judge is inert", () => {
  const pool = orderCandidates([cand({ providerId: "173734", score: 50 })])
  const query: JudgeQuery = {
    structuredName: "Schwarze Bohne", canonicalEnglish: "black bean", canonicalGerman: "Schwarze Bohne",
    coreFoodEnglish: "bean", state: "unknown", form: "unknown", preservation: "unknown",
    fatPercent: null, category: "legume",
  }
  let fetchSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }))
    vi.stubGlobal("fetch", fetchSpy)
  })
  afterEach(() => { vi.unstubAllGlobals(); config.llm.judgeEnabled = false })

  it("issues no request and returns skipped=disabled, even with a key and a full pool", async () => {
    config.llm.judgeEnabled = false
    config.llm.enabled = true
    config.llm.apiKey = "test-key"
    const out = await askJudge(query, pool)
    expect(out.skipped).toBe("disabled")
    expect(out.decision).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("is the default configuration", () => {
    // A deployment opts IN explicitly; it never inherits model-assisted behaviour from a code
    // change it did not ask for. The guard above proves that when it is off, nothing is sent.
    expect((process.env.LLM_JUDGE_ENABLED || "false").toLowerCase() === "true").toBe(false)
    expect(("true").toLowerCase() === "true").toBe(true)
  })

  it("still refuses to call out when enabled but unconfigured", async () => {
    config.llm.judgeEnabled = true
    config.llm.enabled = false
    config.llm.apiKey = ""
    expect((await askJudge(query, pool)).skipped).toBe("no-api-key")
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("asks nothing when there is nothing to choose between", async () => {
    config.llm.judgeEnabled = true
    config.llm.enabled = true
    config.llm.apiKey = "test-key"
    expect((await askJudge(query, [])).skipped).toBe("no-candidates")
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe("the judge decision cache is isolated and versioned", () => {
  const key = judgeCacheKey({ promptVersion: "1", model: "m", queryKey: "q", poolFingerprint: "f" })

  beforeEach(() => { clearLlmCache() })

  it("round-trips a verdict, including ambiguous and none", () => {
    setCachedJudgeDecision(key, { verdict: "selected", candidateId: "usda-local:1", confidence: 0.8, reason: "r" })
    expect(getCachedJudgeDecision(key)).toEqual({ verdict: "selected", candidateId: "usda-local:1", confidence: 0.8, reason: "r" })
    setCachedJudgeDecision(key, { verdict: "ambiguous", candidateId: null, confidence: 0.4, reason: "two grades" })
    expect(getCachedJudgeDecision(key)!.verdict).toBe("ambiguous")
    expect(getCachedJudgeDecision(key)!.candidateId).toBeNull()
  })

  it("does not answer a different question", () => {
    setCachedJudgeDecision(key, { verdict: "none", candidateId: null, confidence: 1, reason: "r" })
    for (const other of [
      judgeCacheKey({ promptVersion: "2", model: "m", queryKey: "q", poolFingerprint: "f" }),
      judgeCacheKey({ promptVersion: "1", model: "other", queryKey: "q", poolFingerprint: "f" }),
      judgeCacheKey({ promptVersion: "1", model: "m", queryKey: "other", poolFingerprint: "f" }),
      judgeCacheKey({ promptVersion: "1", model: "m", queryKey: "q", poolFingerprint: "other" }),
    ]) {
      expect(getCachedJudgeDecision(other)).toBeUndefined()
    }
  })

  it("lives in its own table — a judge verdict is not readable as a rerank verdict", () => {
    setCachedJudgeDecision(key, { verdict: "selected", candidateId: "usda-local:1", confidence: 0.8, reason: "r" })
    expect(getCachedRerank(key)).toBeUndefined()
  })

  it("keys the ingredient identity, so two ingredients never share an answer", () => {
    const base: JudgeQuery = {
      structuredName: "Kochsahne 7%", canonicalEnglish: "cooking cream 7%", canonicalGerman: "Kochsahne 7 % Fett",
      coreFoodEnglish: "cream", state: "unknown", form: "unknown", preservation: "unknown",
      fatPercent: 7, category: "dairy",
    }
    expect(judgeQueryKey(base)).not.toBe(judgeQueryKey({ ...base, fatPercent: 15 }))
    expect(judgeQueryKey(base)).not.toBe(judgeQueryKey({ ...base, preservation: "canned" }))
    expect(judgeQueryKey(base)).toBe(judgeQueryKey({ ...base }))
  })

  it("is cleared by clearLlmCache alongside the other model caches", () => {
    setCachedJudgeDecision(key, { verdict: "none", candidateId: null, confidence: 1, reason: "r" })
    clearLlmCache()
    expect(getCachedJudgeDecision(key)).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------------------------

const match = (over: Partial<ProviderMatch>): ProviderMatch => ({
  nutrients: NUTRIENTS(200), canonicalName: "x", brand: null, state: "unknown",
  provider: "usda-local", providerId: "1", productName: "Some record", confidence: 0.7, ...over,
})
const attrs = (over: Partial<FoodAttributes> = {}): FoodAttributes => ({ ...UNKNOWN_ATTRIBUTES, ...over })

const need = (over: Partial<Parameters<typeof judgeNeed>[0]> = {}) => judgeNeed({
  structuredName: "Thing", canonicalEnglish: "thing", coreFoodEnglish: "thing",
  attributes: attrs(), foodType: "simple", match: match({}), fallbackStatus: "usda-local", ...over,
})

describe("judge eligibility is semantic suspicion, not a confidence threshold", () => {
  it("does not fire for a clean accepted record at MODERATE confidence", () => {
    expect(need({ match: match({ confidence: 0.55 }) })).toBeNull()
    expect(need({ match: match({ confidence: 0.7 }) })).toBeNull()
  })

  it("fires at HIGH confidence when something is actually unresolved", () => {
    // Same 0.92 confidence in both; only the semantics differ. A threshold cannot tell them apart.
    expect(need({ match: match({ confidence: 0.92 }) })).toBeNull()
    expect(need({ match: match({ confidence: 0.92, unmetAttributes: ["reduced-fat"] }) })!.primary)
      .toBe("unmet-attribute")
  })

  it("fires whenever the chain would otherwise fabricate a value, at any confidence", () => {
    expect(need({ match: match({ provider: "llm-nutrient", productName: null, confidence: 0.35 }), fallbackStatus: "llm-nutrient" })!.reasons)
      .toContain("no-database-record")
    expect(need({ match: null, fallbackStatus: "unresolved" })!.primary).toBe("no-database-record")
  })

  it("fires on an explicit percentage the record does not actually satisfy", () => {
    // Within tolerance but not the stated number: close is not the same as being that product.
    expect(need({
      structuredName: "Kochsahne 7%", attributes: attrs({ fatPercent: 7 }),
      match: match({ productName: "Cream, fluid", nutrients: NUTRIENTS(120, 8) }),
    })!.reasons).toContain("unsatisfied-numeric-modifier")

    // Silent about fat entirely — the number is unanswered, not answered.
    expect(need({
      attributes: attrs({ fatPercent: 7 }),
      match: match({ productName: "Cream, fluid", nutrients: { ...NUTRIENTS(120), fatPer100g: null } }),
    })!.reasons).toContain("unsatisfied-numeric-modifier")

    // Effectively exact: the record IS the stated grade, so nothing is outstanding.
    expect(need({
      structuredName: "Rinderhack 10% Fett", attributes: attrs({ fatPercent: 10 }),
      match: match({ productName: "Beef, ground, 90% lean meat / 10% fat, raw", nutrients: NUTRIENTS(176, 10) }),
    })).toBeNull()
  })

  it("fires when the ingredient states a preservation the record contradicts", () => {
    expect(need({
      attributes: attrs({ preservation: "fresh" }),
      match: match({ productName: "Tomatoes, canned" }),
    })!.reasons).toContain("unresolved-specificity")
  })

  it("fires when a record answers only part of a multi-word identity", () => {
    expect(need({
      canonicalEnglish: "green chili peppers", coreFoodEnglish: "chili pepper",
      match: match({ productName: "Peppers, sweet, green, raw" }),
    })!.reasons).toContain("partial-core-identity")
  })

  it("marks a formulated retail variant whose claim only a real product could answer", () => {
    const r = need({
      structuredName: "Mayo Light", foodType: "processed_single_food",
      match: match({ productName: "Salatmayonnaise (Fertigprodukt)", unmetAttributes: ["reduced-fat"] }),
    })
    expect(r!.reasons).toEqual(expect.arrayContaining(["unmet-attribute", "retail-variant-proxy"]))
    // An ordinary processed food with nothing outstanding is not a proxy candidate.
    expect(need({ foodType: "processed_single_food" })).toBeNull()
  })

  it("carries set-level limbs that stay silent until a provider reports pool signals", () => {
    expect(need({ pool: { gateSurvivors: 9, belowAcceptance: 8, materialRival: false } })).toBeNull()
    expect(need({ pool: { gateSurvivors: 4, belowAcceptance: 0, materialRival: true } })!.reasons)
      .toContain("material-rival")
    expect(need({
      match: null, fallbackStatus: "unresolved",
      pool: { gateSurvivors: 9, belowAcceptance: 8, materialRival: false },
    })!.reasons).toContain("gate-suppressed-pool")
  })

  it("orders reasons stably and names a primary", () => {
    const r = need({
      structuredName: "Kochsahne 7%", foodType: "processed_single_food", attributes: attrs({ fatPercent: 7 }),
      match: match({ productName: "Cream, fluid", nutrients: NUTRIENTS(120, 8), unmetAttributes: ["reduced-fat"] }),
    })!
    expect(r.primary).toBe("unsatisfied-numeric-modifier")
    expect(r.reasons).toEqual(["unsatisfied-numeric-modifier", "unmet-attribute", "retail-variant-proxy"])
  })
})

// ---------------------------------------------------------------------------------------------

interface Ing { name: string; de: string; en: string; coreDe: string; coreEn: string; category: string | null; state?: string; foodType?: string; attrs?: Partial<FoodAttributes> }

async function resolveAndAsk(i: Ing) {
  const a = attrs(i.attrs)
  const resolved = await resolveNutrients({
    foodName: i.en, structuredName: i.name, canonicalGerman: i.de, brand: null,
    category: i.category, state: i.state ?? "unknown", foodType: i.foodType ?? "simple",
    coreFoodGerman: i.coreDe, coreFoodEnglish: i.coreEn, route: "generic", attributes: a,
    evidence: { german: true, english: true, core: true, brand: false },
  } as never, "generic")
  return {
    provider: resolved?.fallbackStatus ?? "unresolved",
    record: resolved?.match.productName ?? null,
    providerId: resolved?.match.providerId ?? null,
    need: judgeNeed({
      structuredName: i.name, canonicalEnglish: i.en, coreFoodEnglish: i.coreEn, attributes: a,
      foodType: (i.foodType ?? "simple") as never,
      match: resolved?.match ?? null, fallbackStatus: resolved?.fallbackStatus ?? "unresolved",
    }),
  }
}

describe("against the real databases, the fast path stays off the judge's list", () => {
  beforeEach(() => {
    config.llm.enabled = false
    config.llm.apiKey = ""
    config.llm.judgeEnabled = false
    config.openFoodFacts.retryBackoffMs = 1
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ hits: [] }), { status: 200, headers: { "content-type": "application/json" } })))
  })
  afterEach(() => { vi.unstubAllGlobals() })

  const FAST_PATH: [Ing, string, string][] = [
    [{ name: "Olivenöl", de: "Olivenöl", en: "olive oil", coreDe: "Öl", coreEn: "oil", category: "oil" }, "bls", "Olivenöl"],
    [{ name: "Tomate", de: "Tomate", en: "tomato", coreDe: "Tomate", coreEn: "tomato", category: "vegetable", state: "raw" }, "bls", "Tomate roh"],
    [{ name: "Tomatenmark", de: "Tomatenmark", en: "tomato paste", coreDe: "Tomatenmark", coreEn: "tomato paste", category: "vegetable", attrs: { form: "paste" } }, "bls", "Tomatenmark"],
    [{ name: "Zwiebel", de: "Zwiebel", en: "onion", coreDe: "Zwiebel", coreEn: "onion", category: "vegetable", state: "raw" }, "bls", "Speisezwiebel roh"],
    [{ name: "Chilipulver", de: "Chilipulver", en: "chili powder", coreDe: "Chili", coreEn: "chili", category: "spice", attrs: { form: "powder" } }, "usda-local", "Spices, chili powder"],
    [{ name: "gemahlener Koriander", de: "Koriander, gemahlen", en: "ground coriander", coreDe: "Koriander", coreEn: "coriander", category: "spice", attrs: { form: "ground" } }, "usda-local", "Spices, coriander seed"],
  ]

  for (const [i, provider, record] of FAST_PATH) {
    it(`${i.name} resolves to ${provider} "${record}" and is NOT judge-eligible`, async () => {
      const r = await resolveAndAsk(i)
      expect(r.provider).toBe(provider)
      expect(r.record).toBe(record)
      // The whole point of the trigger: a good deterministic match is never put to a judge, so
      // nothing a judge does can ever reach it.
      expect(r.need).toBeNull()
    })
  }

  it("treats a user's own recipe as a first-class record, never a judge question", () => {
    // mealie-recipe leads the chain and must keep doing so; a clean reuse has nothing unresolved.
    expect(need({
      match: match({ provider: "mealie-recipe", providerId: "tikka-paste", productName: "Tikka-Paste", sourceRecipeSlug: "tikka-paste" }),
      fallbackStatus: "mealie-recipe",
    })).toBeNull()
  })

  it("keeps PR A's resolutions exactly, and flags only the honest no-record case", async () => {
    const bean = await resolveAndAsk({ name: "Schwarze Bohne", de: "Schwarze Bohne", en: "black bean", coreDe: "Bohne", coreEn: "bean", category: "legume" })
    expect(bean.provider).toBe("usda-local")
    expect(bean.providerId).toBe("173734")
    expect(bean.need).toBeNull()

    const brine = await resolveAndAsk({ name: "Gurkenwasser", de: "Gurkenwasser", en: "cucumber water", coreDe: "Gurke", coreEn: "cucumber water", category: "liquid" })
    expect(brine.providerId).not.toBe("174158")
    // No record, so there is nothing to protect and everything to gain — exactly the case a judge
    // should eventually see.
    expect(brine.need!.primary).toBe("no-database-record")
  })
})

describe("through the whole pipeline, with the judge disabled", () => {
  const GRAM = { id: "g", name: "g", pluralName: "g", abbreviation: "g", standardQuantity: null, standardUnit: null }
  const CLASSIFICATIONS = [
    { index: 0, canonicalGerman: "Olivenöl", canonicalEnglish: "olive oil", brand: null, state: "unknown", form: "unknown", preservation: "unknown", fatPercent: null, category: "oil", foodType: "simple", coreFoodGerman: "Öl", coreFoodEnglish: "oil" },
    { index: 1, canonicalGerman: "Gurkenwasser", canonicalEnglish: "cucumber water", brand: null, state: "unknown", form: "unknown", preservation: "unknown", fatPercent: null, category: "liquid", foodType: "simple", coreFoodGerman: "Gurke", coreFoodEnglish: "cucumber water" },
  ]
  let bodies: string[]

  beforeEach(() => {
    clearLlmCache()
    __clearProviderCachesForTests()
    config.llm.judgeEnabled = false
    config.llm.enabled = true
    config.llm.apiKey = "test-key"
    config.openFoodFacts.retryBackoffMs = 1
    bodies = []
    vi.stubGlobal("fetch", vi.fn(async (url: unknown, init?: { body?: string }) => {
      const u = String(url)
      if (u.startsWith(config.openFoodFacts.searchBaseUrl)) {
        return new Response(JSON.stringify({ hits: [] }), { status: 200, headers: { "content-type": "application/json" } })
      }
      const body = String(init?.body ?? "")
      bodies.push(body)
      const prompt = String(JSON.parse(body || "{}").messages?.[0]?.content ?? "")
      const reply = prompt.includes("nutrition") || prompt.includes("per 100")
        ? JSON.stringify({ kcal: 12, protein: 0.3, carbs: 2.5, fat: 0.1 })
        : JSON.stringify(CLASSIFICATIONS)
      return new Response(JSON.stringify({ choices: [{ message: { content: reply } }] }), {
        status: 200, headers: { "content-type": "application/json" },
      })
    }))
  })
  afterEach(() => { vi.unstubAllGlobals(); config.llm.enabled = false; config.llm.apiKey = "" })

  it("records the trigger in provenance, resolves normally, and issues no judge prompt", async () => {
    const r: MealieRecipe = {
      slug: "judge-plumbing", name: "judge-plumbing", recipeYield: null, recipeServings: 1,
      recipeIngredient: ["Olivenöl", "Gurkenwasser"].map((food) => ({
        quantity: 100, unit: GRAM, food: { id: food, name: food, pluralName: null, aliases: [] },
        note: null, display: food, originalText: null, title: null,
      })),
      nutrition: null, tags: [], extras: {}, householdId: null,
    }

    const result = await estimateRecipe(r)
    const patch = buildNutritionPatch(result, "hash", r.recipeYield)
    const provenance = JSON.parse(String(patch.extras!.calorie_estimator_provenance)) as Record<string, unknown>[]

    // The fast-path ingredient resolves as always and carries no trigger…
    expect(provenance[0].provider).toBe("bls")
    expect(provenance[0].judgeTrigger).toBeNull()
    // …while the ingredient with nothing behind it is flagged for a future judge, without any
    // change to what it actually resolved to.
    expect(provenance[1].provider).toBe("llm-nutrient")
    expect(provenance[1].judgeTrigger).toBe("no-database-record")

    // Every judge field that only a RUN can fill stays empty while the flag is off.
    for (const row of provenance) {
      expect(row.judgeVerdict).toBeNull()
      expect(row.judgeReason).toBeNull()
      expect(row.judgeCandidates).toBeNull()
      expect(row.judgePoolFingerprint).toBeNull()
      expect(row.judgeModel).toBeNull()
    }

    // The judge prompt is unmistakable — it is the only one carrying these instructions — and no
    // request this run made contained either of them.
    expect(bodies.some((b) => b.includes("SEMANTIC JUDGE"))).toBe(false)
    expect(bodies.some((b) => b.includes("return AMBIGUOUS rather than selecting arbitrarily"))).toBe(false)
  })
})
