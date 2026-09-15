import { describe, it, expect, beforeAll, vi } from "vitest"
import { initCache } from "../../src/utils/cache.js"
import { BlsProvider, __buildTestBlsData, __resetBlsDataForTests } from "../../src/services/providers/bls-provider.js"
import type { NutrientSet } from "../../src/types.js"
import type { ProviderQuery } from "../../src/services/providers/types.js"

function nutrients(overrides: Partial<NutrientSet> = {}): NutrientSet {
  return {
    kcalPer100g: 78, // Atwater-consistent with the default macros below (4*5 + 4*10 + 9*2 = 78)
    proteinPer100g: 5,
    carbsPer100g: 10,
    fatPer100g: 2,
    saturatedFatPer100g: 1,
    transFatPer100g: null,
    unsaturatedFatPer100g: 1,
    fiberPer100g: 2,
    sugarPer100g: 3,
    sodiumPer100g: 0.1,
    cholesterolPer100g: 0,
    ...overrides,
  }
}

function query(overrides: Partial<ProviderQuery> = {}): ProviderQuery {
  return { foodName: "Test", structuredName: "Test", brand: null, category: null, state: "unknown", ...overrides }
}

// Every test below uses its own uniquely-named synthetic food (never a real BLS word like
// "Honig"/"Kartoffel" more than once) — the BLS provider caches by (food name + state), and
// reusing the same name across two tests with two different injected datasets would let one
// test's cached result silently leak into another's (found live while writing these tests).

describe("BlsProvider — synthetic fixtures (deterministic algorithmic behavior)", () => {
  beforeAll(async () => {
    await initCache()
  })

  it("exact German BLS match: bare structured name matching a BLS name verbatim", async () => {
    __resetBlsDataForTests(
      Promise.resolve(
        __buildTestBlsData([
          { blsCode: "S120000", nameDe: "Testhonig1", nameEn: "Test Honey 1", inferredState: "unknown", nutrients: nutrients({ kcalPer100g: 305, proteinPer100g: 0.3, carbsPer100g: 76, fatPer100g: 0 }) },
        ]),
      ),
    )
    const provider = new BlsProvider()
    const match = await provider.lookup(query({ foodName: "Testhonig1", structuredName: "Testhonig1" }))

    expect(match).not.toBeNull()
    expect(match!.provider).toBe("bls")
    expect(match!.providerId).toBe("S120000")
    expect(match!.productName).toBe("Testhonig1")
    expect(match!.confidence).toBeGreaterThanOrEqual(0.9)
    expect(match!.nutrients.kcalPer100g).toBe(305)
  })

  it("fuzzy German match: a bare word prefix-matching a longer, state-qualified BLS name", async () => {
    __resetBlsDataForTests(
      Promise.resolve(
        __buildTestBlsData([
          {
            blsCode: "K110100",
            nameDe: "Testkartoffel2 geschält, roh",
            nameEn: "Test Potato 2 peeled, raw",
            inferredState: "raw",
            nutrients: nutrients({ kcalPer100g: 83 }),
          },
        ]),
      ),
    )
    const provider = new BlsProvider()
    const match = await provider.lookup(query({ foodName: "Testkartoffel2", structuredName: "Testkartoffel2" }))

    expect(match).not.toBeNull()
    expect(match!.providerId).toBe("K110100")
    expect(match!.productName).toBe("Testkartoffel2 geschält, roh")
    // A fuzzy prefix match is confident but strictly below an exact match's confidence.
    expect(match!.confidence).toBeLessThan(0.9)
    expect(match!.confidence).toBeGreaterThan(0.5)
  })

  it("preparation-state mismatch rejection: a raw-only BLS name is rejected for a cooked query with no alternative", async () => {
    __resetBlsDataForTests(
      Promise.resolve(
        __buildTestBlsData([
          { blsCode: "T001", nameDe: "Testgemuese3 roh", inferredState: "raw", nutrients: nutrients() },
        ]),
      ),
    )
    const provider = new BlsProvider()
    const match = await provider.lookup(query({ foodName: "Testgemuese3", structuredName: "Testgemuese3", state: "cooked" }))

    expect(match).toBeNull()
  })

  it("preparation-state: a same-scoring cooked alternative IS picked over the raw top candidate", async () => {
    __resetBlsDataForTests(
      Promise.resolve(
        __buildTestBlsData([
          { blsCode: "T001", nameDe: "Testgemuese4 roh", inferredState: "raw", nutrients: nutrients({ kcalPer100g: 40 }) },
          { blsCode: "T002", nameDe: "Testgemuese4 gekocht", inferredState: "cooked", nutrients: nutrients({ kcalPer100g: 35 }) },
        ]),
      ),
    )
    const provider = new BlsProvider()
    const match = await provider.lookup(query({ foodName: "Testgemuese4", structuredName: "Testgemuese4", state: "cooked" }))

    expect(match).not.toBeNull()
    expect(match!.providerId).toBe("T002")
    expect(match!.nutrients.kcalPer100g).toBe(35)
  })

  it("ambiguous low-confidence match: partial multi-word overlap below the conservative threshold is rejected, not guessed", async () => {
    __resetBlsDataForTests(
      Promise.resolve(
        __buildTestBlsData([
          { blsCode: "A001", nameDe: "Apfel5 Birnen5 Torte5", inferredState: "unknown", nutrients: nutrients() },
        ]),
      ),
    )
    const provider = new BlsProvider()
    // Shares only one of three words ("Apfel5") with the only candidate — a real BLS-style
    // ambiguous partial match, not a clean miss.
    const match = await provider.lookup(query({ foodName: "Apfel5 Zimt5 Kuchen5", structuredName: "Apfel5 Zimt5 Kuchen5" }))

    expect(match).toBeNull()
  })

  it("missing nutrient stays unknown: a null BLS field stays null in the resolved NutrientSet, never becomes 0", async () => {
    __resetBlsDataForTests(
      Promise.resolve(
        __buildTestBlsData([
          {
            blsCode: "M001",
            nameDe: "Testmystfrucht6",
            inferredState: "unknown",
            nutrients: nutrients({ fiberPer100g: null, sodiumPer100g: null }),
          },
        ]),
      ),
    )
    const provider = new BlsProvider()
    const match = await provider.lookup(query({ foodName: "Testmystfrucht6", structuredName: "Testmystfrucht6" }))

    expect(match).not.toBeNull()
    expect(match!.nutrients.fiberPer100g).toBeNull()
    expect(match!.nutrients.sodiumPer100g).toBeNull()
    // transFatPer100g is never populated from BLS 4.0 at all (no total-trans-fat component) —
    // always unknown, regardless of what the fixture sets.
    expect(match!.nutrients.transFatPer100g).toBeNull()
  })

  it("regression: an exact token buried inside an unrelated multi-word DISH name must not be treated as a compound-suffix match", async () => {
    // Found live: "Koriander" (coriander, a herb) matched "Rote-Linsensuppe mit Koriander10" (a
    // whole lentil-soup dish) because "koriander10" trivially "ends with" itself as a bare
    // standalone token — the suffix rule didn't originally require the matched token to be
    // strictly LONGER than the query (genuine compounding, e.g. "Speisezwiebel"/"zwiebel"), so an
    // exact token buried among clearly-different food words got the same confident bonus.
    __resetBlsDataForTests(
      Promise.resolve(
        __buildTestBlsData([
          { blsCode: "X002", nameDe: "Rote-Linsensuppe mit Koriander10", inferredState: "unknown", nutrients: nutrients({ kcalPer100g: 90, proteinPer100g: 5, carbsPer100g: 12, fatPer100g: 2 }) },
        ]),
      ),
    )
    const provider = new BlsProvider()
    const match = await provider.lookup(query({ foodName: "Koriander10", structuredName: "Koriander10" }))

    expect(match).toBeNull()
  })

  it("regression: prefix/suffix matching must not apply to BLS's English name, only German", async () => {
    // Found live: "Egg" (the LLM-translated canonicalName for "Ei") prefix-matched the English
    // name "Egg pasta raw" (BLS's translation of "Eierteigwaren roh" — pasta made WITH egg, not
    // egg itself), at full prefix confidence, because English noun phrases don't follow BLS's
    // disciplined German "base food, comma-separated state qualifier" convention that the prefix/
    // suffix rules were designed around. Only jaccard (weaker, safer) applies to English names.
    __resetBlsDataForTests(
      Promise.resolve(
        __buildTestBlsData([
          { blsCode: "E13", nameDe: "Testteigwaren13, roh", nameEn: "Egg13 pasta raw", inferredState: "raw", nutrients: nutrients({ kcalPer100g: 346, proteinPer100g: 12, carbsPer100g: 69, fatPer100g: 2, cholesterolPer100g: 0 }) },
        ]),
      ),
    )
    const provider = new BlsProvider()
    // structuredName (German, "Ei13") has no relation to the candidate at all — this isolates the
    // English-name pass specifically (foodName = the LLM's English translation).
    const match = await provider.lookup(query({ foodName: "Egg13", structuredName: "Ei13" }))

    expect(match).toBeNull()
  })

  it("regression: a very short query must not suffix-match a coincidentally-ending, semantically opposite compound", async () => {
    // Found live: "Ei" (egg, 2 letters) matched "Teigwaren eifrei11, roh" (EGG-FREE pasta) — a
    // NEGATION compound ("-frei" = "without"), not a real "type of egg". "eifrei11" happens to
    // end in "ei" purely because "frei" itself ends in "-ei" (a common, unrelated German word
    // ending: also Bäckerei, Brauerei, Molkerei, ...), not because of any genuine relationship to
    // "Ei". Below a minimum query length, this kind of coincidental ending is more likely than
    // real compounding, so the suffix rule doesn't apply at all and the query correctly finds
    // nothing rather than an inverted nutrition profile.
    __resetBlsDataForTests(
      Promise.resolve(
        __buildTestBlsData([
          { blsCode: "E401000", nameDe: "Testteigwaren12 eifrei, roh", inferredState: "raw", nutrients: nutrients({ kcalPer100g: 346, proteinPer100g: 12, carbsPer100g: 69, fatPer100g: 2, cholesterolPer100g: 0 }) },
        ]),
      ),
    )
    const provider = new BlsProvider()
    // "Ei" is short enough (2 letters) to trigger the guard; this exact string isn't reused as a
    // query elsewhere in this file, so it can't collide with another test's cached result.
    const match = await provider.lookup(query({ foodName: "Ei", structuredName: "Ei" }))

    expect(match).toBeNull()
  })

  it("regression: a hyphen-joined compound DISH name must not prefix-match a bare generic-food query", async () => {
    // Found live: "Kartoffel" incorrectly prefix-matched "Kartoffel-Tomaten-Gratin mit
    // Mozzarella" (a casserole) because the shared tokenizer turns hyphens into token
    // boundaries. BLS's own state-qualifier syntax uses comma/slash, never hyphen for that.
    __resetBlsDataForTests(
      Promise.resolve(
        __buildTestBlsData([
          { blsCode: "X001", nameDe: "Testkartoffel7-Tomaten-Gratin mit Mozzarella", inferredState: "unknown", nutrients: nutrients({ kcalPer100g: 180, proteinPer100g: 8, carbsPer100g: 15, fatPer100g: 10 }) },
        ]),
      ),
    )
    const provider = new BlsProvider()
    const match = await provider.lookup(query({ foodName: "Testkartoffel7", structuredName: "Testkartoffel7" }))

    expect(match).toBeNull()
  })

  it("regression: matching is state-aware in the cache — a cooked-state resolution is not reused for the same food name at a different state", async () => {
    __resetBlsDataForTests(
      Promise.resolve(
        __buildTestBlsData([
          { blsCode: "T001", nameDe: "Testgemuese8 roh", inferredState: "raw", nutrients: nutrients({ kcalPer100g: 40 }) },
          { blsCode: "T002", nameDe: "Testgemuese8 gekocht", inferredState: "cooked", nutrients: nutrients({ kcalPer100g: 35 }) },
        ]),
      ),
    )
    const provider = new BlsProvider()

    const cooked = await provider.lookup(query({ foodName: "Testgemuese8", structuredName: "Testgemuese8", state: "cooked" }))
    const raw = await provider.lookup(query({ foodName: "Testgemuese8", structuredName: "Testgemuese8", state: "raw" }))

    expect(cooked!.providerId).toBe("T002")
    expect(raw!.providerId).toBe("T001")
  })

  it("uses the raw structured German name over a possibly-English LLM canonicalName", async () => {
    __resetBlsDataForTests(
      Promise.resolve(
        __buildTestBlsData([
          { blsCode: "S120000", nameDe: "Testhonig9", nameEn: "Test Honey 9", inferredState: "unknown", nutrients: nutrients({ kcalPer100g: 305, proteinPer100g: 0.3, carbsPer100g: 76, fatPer100g: 0 }) },
        ]),
      ),
    )
    const provider = new BlsProvider()
    // foodName (canonicalName) has been translated to English by the LLM normalizer;
    // structuredName still carries the original German food.name.
    const match = await provider.lookup(query({ foodName: "Test Honey 9", structuredName: "Testhonig9" }))

    expect(match).not.toBeNull()
    expect(match!.providerId).toBe("S120000")
  })
})

describe("BlsProvider — real bundled BLS 4.0 data (sanity check against the actual dataset)", () => {
  beforeAll(async () => {
    await initCache()
    __resetBlsDataForTests(null) // force a real reload from the bundled file, undoing any synthetic reset above
  })

  it("resolves a real, unambiguous German food name from the bundled database", async () => {
    const provider = new BlsProvider()
    const match = await provider.lookup(query({ foodName: "Honig", structuredName: "Honig" }))

    expect(match).not.toBeNull()
    expect(match!.provider).toBe("bls")
    expect(match!.nutrients.kcalPer100g).toBeGreaterThan(0)
  })
})

describe("BLS in the routing-aware provider chain", () => {
  it("no OFF call for a strong generic-route BLS match", async () => {
    vi.resetModules()
    const offLookup = vi.fn()
    vi.doMock("../../src/services/providers/off-provider.js", () => ({
      offProvider: { name: "off", lookup: offLookup },
    }))

    await (await import("../../src/utils/cache.js")).initCache()
    const { __resetBlsDataForTests: resetBls } = await import("../../src/services/providers/bls-provider.js")
    resetBls(null) // real bundled data — "Honig" is a genuine strong match there

    const { resolveNutrients } = await import("../../src/services/nutrient-resolver.js")
    const result = await resolveNutrients(query({ foodName: "Honig", structuredName: "Honig" }), "generic")

    expect(result).not.toBeNull()
    expect(result!.fallbackStatus).toBe("bls")
    expect(offLookup).not.toHaveBeenCalled()

    vi.doUnmock("../../src/services/providers/off-provider.js")
  })

  it("falls through to USDA only when BLS has no acceptable result", async () => {
    vi.resetModules()
    const usdaMatch = {
      nutrients: nutrients({ kcalPer100g: 78 }),
      canonicalName: "Ganz Unbekanntes Ding",
      brand: null,
      state: "unknown" as const,
      provider: "usda",
      providerId: "usda-1",
      productName: "Ganz Unbekanntes Ding",
      confidence: 0.8,
    }
    const usdaLookup = vi.fn().mockResolvedValue(usdaMatch)
    vi.doMock("../../src/services/providers/usda-provider.js", () => ({
      createUsdaProviderIfConfigured: () => ({ name: "usda", lookup: usdaLookup }),
    }))
    // OFF now comes before USDA in the generic-route chain — mock it out (rather than let a real
    // network call decide the test) so this test stays about "BLS miss -> USDA", not OFF's live
    // search behavior for an intentionally-nonsense food name.
    const offLookup = vi.fn().mockResolvedValue(null)
    vi.doMock("../../src/services/providers/off-provider.js", () => ({
      offProvider: { name: "off", lookup: offLookup },
    }))

    await (await import("../../src/utils/cache.js")).initCache()
    const { config } = await import("../../src/config.js")
    config.usda.apiKey = "test-key"

    const { __resetBlsDataForTests: resetBls, __buildTestBlsData: buildTestData } = await import("../../src/services/providers/bls-provider.js")
    resetBls(Promise.resolve(buildTestData([]))) // BLS has nothing at all

    const { resolveNutrients } = await import("../../src/services/nutrient-resolver.js")
    const result = await resolveNutrients(query({ foodName: "Ganz Unbekanntes Ding", structuredName: "Ganz Unbekanntes Ding" }), "generic")

    expect(result).not.toBeNull()
    expect(result!.fallbackStatus).toBe("usda")
    expect(usdaLookup).toHaveBeenCalledTimes(1)

    config.usda.apiKey = ""
    vi.doUnmock("../../src/services/providers/usda-provider.js")
    vi.doUnmock("../../src/services/providers/off-provider.js")
  })
})

describe("BlsProvider — an incompatible cached entry is a true cache miss, not a provider miss (M2)", () => {
  // Same defect class as OFF/USDA, but with no network cost at all: a stale positive entry made a
  // different, perfectly valid BLS record unreachable for the whole CACHE_MATCH_TTL.
  const N = {
    kcalPer100g: 20, proteinPer100g: 1, carbsPer100g: 3, fatPer100g: 0.2, saturatedFatPer100g: 0,
    transFatPer100g: null, unsaturatedFatPer100g: 0.2, fiberPer100g: 0, sugarPer100g: 1,
    sodiumPer100g: 0.3, cholesterolPer100g: 0,
  }

  function blsQuery(foodType: "composite_dish" | "simple", name = "Testbruehe m2bls") {
    return query({
      foodName: name, structuredName: name, canonicalGerman: name,
      foodType, coreFoodGerman: null, coreFoodEnglish: null,
    })
  }

  it("falls through and re-scores, reaching a different BLS record that IS valid for this context", async () => {
    const name = "Testbruehe m2bls"
    // Both records share the same German name; the X-coded composite one is inserted first, so the
    // exact-match path picks it for a composite query.
    __resetBlsDataForTests(
      Promise.resolve(
        __buildTestBlsData([
          { blsCode: "X900001", nameDe: name, nameEn: "Test broth dish", foodType: "composite_dish", nutrients: { ...N, kcalPer100g: 30 } },
          { blsCode: "R900002", nameDe: name, nameEn: "Test broth", foodType: "simple", nutrients: { ...N, kcalPer100g: 10 } },
        ]),
      ),
    )
    const provider = new BlsProvider()

    const composite = await provider.lookup(blsQuery("composite_dish"))
    expect(composite?.providerId).toBe("X900001")

    // Same cache key, incompatible context. Before the fix this returned null.
    const simple = await provider.lookup(blsQuery("simple"))
    expect(simple?.providerId).toBe("R900002")
    expect(simple?.nutrients.kcalPer100g).toBe(10)
  })

  it("is stable across repeated identical queries — no thrashing", async () => {
    const name = "Testbruehe m2bls-stable"
    __resetBlsDataForTests(
      Promise.resolve(
        __buildTestBlsData([
          { blsCode: "X900003", nameDe: name, nameEn: "Test broth dish", foodType: "composite_dish", nutrients: { ...N, kcalPer100g: 30 } },
          { blsCode: "R900004", nameDe: name, nameEn: "Test broth", foodType: "simple", nutrients: { ...N, kcalPer100g: 10 } },
        ]),
      ),
    )
    const provider = new BlsProvider()

    await provider.lookup(blsQuery("composite_dish", name))
    const a = await provider.lookup(blsQuery("simple", name))
    const b = await provider.lookup(blsQuery("simple", name))
    const c = await provider.lookup(blsQuery("simple", name))

    expect([a?.providerId, b?.providerId, c?.providerId]).toEqual(["R900004", "R900004", "R900004"])
  })
})
