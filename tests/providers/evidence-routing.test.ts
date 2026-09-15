import { describe, it, expect, beforeEach, beforeAll, vi } from "vitest"
import { config } from "../../src/config.js"
import { initCache, clearLlmCache } from "../../src/utils/cache.js"
import { offProvider } from "../../src/services/providers/off-provider.js"
import { createUsdaProviderIfConfigured } from "../../src/services/providers/usda-provider.js"
import { createBlsProviderIfAvailable, __buildTestBlsData, __resetBlsDataForTests } from "../../src/services/providers/bls-provider.js"
import { evidenceFor, evidenceKey, mayQueryOff, usesDegradedBlsPolicy, FULL_EVIDENCE } from "../../src/services/identity-evidence.js"
import { matchingContextKey, rankCandidates, MIN_ACCEPTABLE_SCORE } from "../../src/services/providers/ranking.js"
import type { ProviderQuery } from "../../src/services/providers/types.js"
import type { NutrientSet } from "../../src/types.js"

const n = (kcal: number): NutrientSet => ({
  kcalPer100g: kcal, proteinPer100g: 1, carbsPer100g: 1, fatPer100g: 1, saturatedFatPer100g: null,
  transFatPer100g: null, unsaturatedFatPer100g: null, fiberPer100g: null, sugarPer100g: null,
  sodiumPer100g: null, cholesterolPer100g: null,
})

const DEGRADED = { german: true, english: false, core: false, brand: false }
const HEALTHY = FULL_EVIDENCE

function q(over: Partial<ProviderQuery> = {}): ProviderQuery {
  return {
    foodName: "x", structuredName: "x", brand: null, category: null, state: "unknown",
    foodType: "unknown", coreFoodGerman: null, coreFoodEnglish: null, route: "generic",
    evidence: DEGRADED, ...over,
  } as ProviderQuery
}

beforeAll(async () => { await initCache() })
beforeEach(() => {
  config.llm.enabled = false
  config.llm.apiKey = ""
  clearLlmCache()
  vi.restoreAllMocks()
})

describe("identity evidence representation", () => {
  it("is composable — brand evidence coexists with validated multilingual identity", () => {
    const e = evidenceFor({ llmClassified: true, canonicalGerman: "Joghurt", coreFoodGerman: "Joghurt", coreFoodEnglish: "yogurt", brand: "Chobani" }, "Chobani Greek Yogurt")
    expect(e).toEqual({ german: true, english: true, core: true, brand: true })
  })

  it("never invents English identity from a German raw name", () => {
    const e = evidenceFor({ llmClassified: false, canonicalGerman: "Minze", coreFoodGerman: null, coreFoodEnglish: null, brand: null }, "Minze")
    expect(e.german).toBe(true)
    expect(e.english).toBe(false)
    expect(e.core).toBe(false)
  })

  it("distinguishes all the routing-relevant capability combinations in the cache key", () => {
    const keys = new Set([
      evidenceKey(HEALTHY),
      evidenceKey(DEGRADED),
      evidenceKey({ german: true, english: true, core: false, brand: false }),
      evidenceKey({ german: true, english: false, core: false, brand: true }),
    ])
    expect(keys.size).toBe(4)
  })
})

describe("degraded BLS two-stage policy", () => {
  // X416243 is a real composite (group X) and NOT ingredient_preferred: reachable only via the
  // exact-name escape hatch. G541100/G660100 are the curated raw vegetables.
  const data = () => __buildTestBlsData([
    { blsCode: "X416243", nameDe: "Gemüsebrühe", ingredientPreferred: false, foodType: "composite_dish", nutrients: n(4) },
    { blsCode: "E111132", nameDe: "Hühnerei gekocht", ingredientPreferred: false, inferredState: "cooked", nutrients: n(144) },
    { blsCode: "G750432", nameDe: "Sojabohne reif, gekocht", ingredientPreferred: false, inferredState: "cooked", nutrients: n(157) },
    { blsCode: "G750400", nameDe: "Sojabohne reif", ingredientPreferred: true, nutrients: n(388) },
    { blsCode: "G560400", nameDe: "Tomate getrocknet", ingredientPreferred: false, inferredState: "dried", nutrients: n(276) },
    { blsCode: "X553912", nameDe: "Paprika gedünstet (mit Fett und Salz)", ingredientPreferred: false, foodType: "composite_dish", nutrients: n(56) },
    { blsCode: "G541100", nameDe: "Gemüsepaprika grün, roh", ingredientPreferred: true, nutrients: n(38) },
    { blsCode: "X566412", nameDe: "Sellerie gekocht, mit Sahne", ingredientPreferred: false, foodType: "composite_dish", nutrients: n(31) },
    { blsCode: "G660100", nameDe: "Knollensellerie roh", ingredientPreferred: true, nutrients: n(30) },
  ])

  beforeEach(() => { __resetBlsDataForTests(Promise.resolve(data())) })

  it("stage 1: an exact German name reaches a NON-preferred row (Gemüsebrühe escape hatch)", async () => {
    const m = await createBlsProviderIfAvailable().lookup(q({ foodName: "Gemüsebrühe", structuredName: "Gemüsebrühe" }))
    expect(m?.providerId).toBe("X416243")
  })

  it("stage 1: unknown query state alone must not reject an exact structured-name match", async () => {
    for (const [name, code] of [["Hühnerei gekocht", "E111132"], ["Tomate getrocknet", "G560400"]] as const) {
      const m = await createBlsProviderIfAvailable().lookup(q({ foodName: name, structuredName: name, state: "unknown" }))
      expect(m?.providerId, name).toBe(code)
    }
  })

  it("stage 1 keeps the correct cooked variant instead of the preferred raw one", async () => {
    const m = await createBlsProviderIfAvailable().lookup(q({ foodName: "Sojabohne reif, gekocht", structuredName: "Sojabohne reif, gekocht" }))
    expect(m?.providerId).toBe("G750432")   // cooked, 157 kcal
    expect(m?.providerId).not.toBe("G750400") // not the raw 388 kcal preferred row
  })

  it("stage 2: no exact match -> fuzzy within ingredient_preferred only, never a composite", async () => {
    for (const [name, code, forbidden] of [["Paprika", "G541100", "X553912"], ["Sellerie", "G660100", "X566412"]] as const) {
      const m = await createBlsProviderIfAvailable().lookup(q({ foodName: name, structuredName: name }))
      expect(m?.providerId, name).toBe(code)
      expect(m?.providerId, name).not.toBe(forbidden)
    }
  })

  it("healthy mode is unchanged — the full pool is still searched", async () => {
    const m = await createBlsProviderIfAvailable().lookup(q({ foodName: "Paprika", structuredName: "Paprika", evidence: HEALTHY }))
    expect(m).not.toBeNull() // full pool available; no preferred-only restriction applied
  })

  it("stage 1 + stage 2 exhausted writes a scoped miss that short-circuits the same profile", async () => {
    const p = createBlsProviderIfAvailable()
    const name = "Vollkommen Unbekannt XYZ"
    expect(await p.lookup(q({ foodName: name, structuredName: name }))).toBeNull()

    // A recorded miss short-circuits before the BLS table is consulted again: swap in an empty
    // dataset — a re-scan would now be observable, a short-circuit is not.
    __resetBlsDataForTests(Promise.resolve(__buildTestBlsData([])))
    expect(await p.lookup(q({ foodName: name, structuredName: name }))).toBeNull()
    // and restoring a dataset that WOULD match proves the short-circuit really happened
    __resetBlsDataForTests(Promise.resolve(__buildTestBlsData([
      { blsCode: "Z999999", nameDe: name, ingredientPreferred: true, nutrients: n(1) },
    ])))
    expect(await p.lookup(q({ foodName: name, structuredName: name }))).toBeNull()
  })

  it("a degraded miss does not poison a later healthy lookup of the same food", async () => {
    const p = createBlsProviderIfAvailable()
    // Only a composite exists; degraded stage 2 (preferred-only) cannot reach it.
    __resetBlsDataForTests(Promise.resolve(__buildTestBlsData([
      { blsCode: "X111111", nameDe: "Etwas Zubereitetes", ingredientPreferred: false, nutrients: n(50) },
    ])))
    expect(await p.lookup(q({ foodName: "Etwas", structuredName: "Etwas" }))).toBeNull()

    // Same food, healthy evidence -> different miss context -> the full pool is searched again.
    const healthy = await p.lookup(q({ foodName: "Etwas Zubereitetes", structuredName: "Etwas Zubereitetes", evidence: HEALTHY }))
    expect(healthy?.providerId).toBe("X111111")
  })

  it("a healthy miss does not poison a later degraded lookup", async () => {
    const p = createBlsProviderIfAvailable()
    __resetBlsDataForTests(Promise.resolve(__buildTestBlsData([])))
    expect(await p.lookup(q({ foodName: "Zwiebel", structuredName: "Zwiebel", evidence: HEALTHY }))).toBeNull()

    __resetBlsDataForTests(Promise.resolve(__buildTestBlsData([
      { blsCode: "G480100", nameDe: "Zwiebel", ingredientPreferred: true, nutrients: n(28) },
    ])))
    const degraded = await p.lookup(q({ foodName: "Zwiebel", structuredName: "Zwiebel" }))
    expect(degraded?.providerId).toBe("G480100")
  })

  it("a positive cached match accepted in healthy mode is re-resolved, not replayed, under the degraded policy", async () => {
    const p = createBlsProviderIfAvailable()
    // Healthy: the composite is reachable and gets cached for this exact query text.
    __resetBlsDataForTests(Promise.resolve(__buildTestBlsData([
      { blsCode: "X222222", nameDe: "Gulaschsuppe Spezial", ingredientPreferred: false, nutrients: n(90) },
      { blsCode: "G333333", nameDe: "Gulaschsuppe Spezial Gemuese", ingredientPreferred: true, nutrients: n(20) },
    ])))
    const healthy = await p.lookup(q({ foodName: "Gulaschsuppe Spezial", structuredName: "Gulaschsuppe Spezial", evidence: HEALTHY }))
    expect(healthy?.providerId).toBe("X222222")

    // Degraded, same query text: X222222 IS an exact name match, so stage 1 legitimately keeps it.
    // Change the query text so the cached candidate is neither preferred nor an exact match.
    const degraded = await p.lookup(q({ foodName: "Gulaschsuppe", structuredName: "Gulaschsuppe" }))
    expect(degraded?.providerId).not.toBe("X222222")
  })
})

describe("evidence-scoped negative cache", () => {
  it("degraded and healthy lookups produce different miss contexts", () => {
    const base = { foodName: "Minze", category: null, foodType: "unknown" as const, coreFood: null }
    expect(matchingContextKey({ ...base, evidence: DEGRADED }))
      .not.toBe(matchingContextKey({ ...base, evidence: HEALTHY }))
  })

  it("the same evidence profile produces a stable key, so repeated misses still short-circuit", () => {
    const base = { foodName: "Minze", category: null, foodType: "unknown" as const, coreFood: null }
    expect(matchingContextKey({ ...base, evidence: DEGRADED }))
      .toBe(matchingContextKey({ ...base, evidence: { ...DEGRADED } }))
  })
})

describe("provider routing by evidence", () => {
  it("OFF is permitted with verified brand evidence", () => {
    expect(mayQueryOff({ german: true, english: false, core: false, brand: true })).toBe(true)
  })

  it("OFF is permitted with validated English + core identity", () => {
    expect(mayQueryOff(HEALTHY)).toBe(true)
  })

  it("OFF is NOT queried for a degraded German-only ingredient — and writes no miss", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    const m = await offProvider.lookup(q({ foodName: "Minze", structuredName: "Minze" }))
    expect(m).toBeNull()
    // skipped by policy: no network call...
    expect(fetchMock).not.toHaveBeenCalled()
    // ...and no miss recorded, so a later healthy lookup is free to query OFF
    const healthy = q({ foodName: "mint", structuredName: "Minze", coreFoodEnglish: "mint", evidence: HEALTHY })
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ hits: [] }) })))
    await offProvider.lookup(healthy)
    // the healthy call DID reach the network (it was not suppressed by a degraded miss)
    expect((globalThis.fetch as any).mock.calls.length).toBeGreaterThan(0)
  })

  it("degraded BLS policy is active exactly when validated English/core identity is missing", () => {
    expect(usesDegradedBlsPolicy(DEGRADED)).toBe(true)
    expect(usesDegradedBlsPolicy(HEALTHY)).toBe(false)
    expect(usesDegradedBlsPolicy({ german: true, english: true, core: false, brand: false })).toBe(true)
  })
})

// The crux of the USDA rule: we never invent an English identity from a German name. Instead the
// degraded query uses its own structured name as the core-identity gate, which is SELF-LIMITING —
// a German word is absent from every correct English candidate description, so a German-only
// ingredient fails closed without any language detection, while a structured-English name passes.
describe("degraded USDA strict mode", () => {
  const fdc = (foods: unknown[]) =>
    new Response(JSON.stringify({ foods }), { status: 200, headers: { "content-type": "application/json" } })
  const kcal = (v: number) => [{ nutrientId: 1008, nutrientName: "Energy", unitName: "KCAL", value: v }]

  beforeEach(() => {
    config.usda.apiKey = "test-key"
    config.usda.retryBackoffMs = 1
  })

  it("a degraded STRUCTURED-ENGLISH ingredient (olive oil) can still use USDA", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      fdc([{ fdcId: 748608, description: "Olive oil", dataType: "SR Legacy", foodNutrients: kcal(884) }]),
    )
    const m = await createUsdaProviderIfConfigured()!.lookup(
      q({ foodName: "olive oil", structuredName: "olive oil" }),
    )
    expect(m?.providerId).toBe("748608")
  })

  // The required invariant, asserted where it actually lives — in ranking, which is a pure
  // function and therefore free of the positive cache's (version|foodName|state|route) keying.
  // "Oil, olive, extra virgin" carries one word beyond the degraded query's own text, which is
  // enough to fail the degraded gate while the healthy query (core "oil") still accepts it.
  it("degraded acceptance is strictly narrower than healthy, never wider", () => {
    const cand = [{ name: "Oil, olive, extra virgin", brand: null, hasCompleteNutrients: true,
                    dataType: "SR Legacy", state: "unknown" as const, foodType: "simple" as const }]
    const score = (core: string) => rankCandidates("olive oil", null, cand, {
      queryState: "unknown", queryCategory: null, queryFoodType: "unknown",
      queryCoreFood: core, dataTypeScore: () => 15,
    })[0]

    const degraded = score("olive oil") // degraded: the structured name IS the gate
    const healthy = score("oil")        // healthy: validated core noun

    expect(degraded.score).toBeLessThan(healthy.score)
    expect(degraded.score).toBeLessThan(MIN_ACCEPTABLE_SCORE)
    expect(healthy.score).toBeGreaterThanOrEqual(MIN_ACCEPTABLE_SCORE)
  })

  it("a degraded GERMAN-only ingredient cannot reach USDA through its raw German name", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      fdc([{ fdcId: 173474, description: "Peppermint, fresh", dataType: "SR Legacy", foodNutrients: kcal(70) }]),
    )
    const m = await createUsdaProviderIfConfigured()!.lookup(
      q({ foodName: "Minze", structuredName: "Minze" }),
    )
    // "minze" is absent from "Peppermint, fresh" -> core-identity conflict -> rejected
    expect(m).toBeNull()
  })

  it("the same German ingredient DOES resolve once a validated English identity exists", async () => {
    // Candidate names the core exactly. "Peppermint, fresh" deliberately does NOT — see the
    // English-core policy test below.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      fdc([{ fdcId: 173474, description: "Mint, fresh", dataType: "SR Legacy", foodNutrients: kcal(70) }]),
    )
    const m = await createUsdaProviderIfConfigured()!.lookup(
      q({ foodName: "mint", structuredName: "Minze", coreFoodEnglish: "mint", evidence: HEALTHY }),
    )
    expect(m?.providerId).toBe("173474")
  })

  // v1 POLICY, deliberately chosen: English core identity requires a whole-token match (plus
  // regular s/es plurals). "Peppermint" is an English closed compound, so core "mint" no longer
  // satisfies it and Minze falls back safely instead of taking a database match. The alternative —
  // substring containment — is what let "Gewürzpaste" match "Spices, allspice, ground", and no
  // token rule can separate "Peppermint, fresh" (correct) from "Peppermints, hard candy" (wrong)
  // since they differ only by a plural "s". A safe fallback is preferred to that risk for v1.
  it("accepts losing Minze -> 'Peppermint, fresh' rather than reopening substring matching", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      fdc([{ fdcId: 173474, description: "Peppermint, fresh", dataType: "SR Legacy", foodNutrients: kcal(70) }]),
    )
    // state "raw" keeps this out of the preceding test's positive cache entry, whose key is
    // (version|foodName|state|route).
    const m = await createUsdaProviderIfConfigured()!.lookup(
      q({ foodName: "mint", structuredName: "Minze", coreFoodEnglish: "mint", state: "raw", evidence: HEALTHY }),
    )
    expect(m).toBeNull() // falls through to the LLM nutrient fallback
  })
})
