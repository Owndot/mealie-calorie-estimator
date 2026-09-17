import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from "vitest"
import { estimateRecipe } from "../../src/services/estimator.js"
import { config } from "../../src/config.js"
import { initCache } from "../../src/utils/cache.js"
import { __resetBlsDataForTests, __buildTestBlsData } from "../../src/services/providers/bls-provider.js"
import { usdaLocalProvider } from "../../src/services/providers/usda-local-provider.js"
import { useUsdaLocalFixture, useEmptyUsdaLocal, resetUsdaLocalFixture } from "../helpers/usda-local-fixture.js"
import { buildQueryKey, setCachedProviderMatch } from "../../src/utils/cache.js"

/** Mirrors USDA_MATCH_ALGORITHM_VERSION; a bump here must be mirrored, which is the point. */
// Mirrors usda-local-provider.ts: algorithm version + the bundled data's schema_version.
const USDA_CACHE_VERSION = "v3/1"
import type { MealieRecipe, MealieIngredient } from "../../src/types.js"

/**
 * End-to-end cache safety through the REAL estimator path (classification -> evidence -> routing ->
 * provider cache), not provider ranking in isolation. The question these answer: can a positive
 * cache entry written under one evidence profile be replayed under a stricter one?
 */

const GRAM = { id: "g", name: "g", pluralName: "g", abbreviation: "g", standardQuantity: null, standardUnit: null }

function ing(name: string): MealieIngredient {
  return { quantity: 100, unit: GRAM, food: { id: name, name, pluralName: null, aliases: [] }, note: null, display: "", title: null, originalText: null }
}
function recipe(name: string, slug: string): MealieRecipe {
  return { slug, name: slug, recipeYield: null, recipeServings: 1, recipeIngredient: [ing(name)], nutrition: null, tags: [], extras: {}, householdId: null }
}

const kcalNutrients = (v: number) => [{ nutrientId: 1008, nutrientName: "Energy", unitName: "KCAL", value: v }]

/** Routes one shared global fetch to whichever upstream the URL belongs to, and counts the calls.
 *  USDA is absent by design — it is a bundled file now, so there is no USDA request to route. */
function router(opts: { llm?: unknown[]; off?: unknown[] }) {
  const calls = { llm: 0, off: 0 }
  const fetchMock = vi.fn(async (url: any) => {
    const u = String(url)
    if (u.startsWith(config.llm.baseUrl)) {
      calls.llm++
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(opts.llm ?? []) } }] }), { status: 200 })
    }
    if (u.startsWith(config.openFoodFacts.searchBaseUrl)) {
      calls.off++
      return new Response(JSON.stringify({ hits: opts.off ?? [] }), { status: 200, headers: { "content-type": "application/json" } })
    }
    return new Response("{}", { status: 200 })
  })
  vi.stubGlobal("fetch", fetchMock)
  return calls
}

const classified = (index: number, de: string, en: string, core: string) => ({
  index, canonicalGerman: de, canonicalEnglish: en, brand: null, state: "unknown",
  category: null, foodType: "simple", coreFoodGerman: de, coreFoodEnglish: core,
})

beforeAll(async () => { await initCache() })
afterEach(() => { resetUsdaLocalFixture() })
beforeEach(async () => {
  // USDA local is emptied for the same reason BLS is: it now sits ahead of OFF in the generic
  // chain, so a real record would answer before OFF and these tests are about OFF. Tests that
  // need a USDA record install their own fixture, which overrides this.
  await useEmptyUsdaLocal()
  // BLS is emptied so it never answers first and mask the OFF/USDA behaviour under test.
  __resetBlsDataForTests(Promise.resolve(__buildTestBlsData([])))
  vi.restoreAllMocks()
})

describe("cached OFF cannot bypass evidence routing", () => {
  it("healthy Minze caches an OFF candidate; the degraded rerun neither reuses it nor calls OFF nor writes a miss", async () => {
    // A product the HEALTHY gate genuinely accepts (core "mint" is present), so there is a real
    // cache entry to attempt a replay of. The live false positive "Aproz Thé Grüntee-minze" is
    // already rejected outright in healthy mode by coreIdentityConflict, so it could never have
    // been cached from a healthy run in the first place.
    const OFF_HIT = [{ product_name: "Mint", brands: [], nutriments: { "energy-kcal_100g": 44 }, categories_tags: ["en:plant-based-foods"] }]

    // --- healthy: validated English + core identity -> OFF permitted, candidate cached
    config.llm.enabled = true
    config.llm.apiKey = "test-key"
    const healthy = router({ llm: [classified(0, "Minze", "mint", "mint")], off: OFF_HIT })
    const r1 = await estimateRecipe(recipe("Minze", "cache-off-healthy"))
    expect(healthy.off).toBeGreaterThan(0)
    expect(r1!.matchedIngredients[0].provider).toBe("off")
    expect(r1!.matchedIngredients[0].productName).toBe("Mint")

    // --- degraded: LLM unavailable -> German-only evidence for the SAME ingredient
    config.llm.enabled = false
    config.llm.apiKey = ""
    const degraded = router({ off: OFF_HIT })
    const r2 = await estimateRecipe(recipe("Minze", "cache-off-degraded"))

    const m = r2!.matchedIngredients[0]
    expect(m.provider).not.toBe("off")               // the cached OFF candidate is NOT reused
    expect(m.productName).not.toBe("Mint")
    expect(degraded.off).toBe(0)                      // OFF was policy-skipped: no network call
  })

  it("the degraded skip writes no OFF miss — a later healthy lookup still reaches OFF", async () => {
    const OFF_HIT = [{ product_name: "Pfefferminze getrocknet", brands: [], nutriments: { "energy-kcal_100g": 44 }, categories_tags: ["en:plant-based-foods"] }]

    config.llm.enabled = false
    config.llm.apiKey = ""
    const skipped = router({ off: OFF_HIT })
    await estimateRecipe(recipe("Pfefferminze", "off-miss-degraded"))
    expect(skipped.off).toBe(0)

    config.llm.enabled = true
    config.llm.apiKey = "test-key"
    const later = router({ llm: [classified(0, "Pfefferminze", "peppermint", "peppermint")], off: OFF_HIT })
    await estimateRecipe(recipe("Pfefferminze", "off-miss-healthy"))
    expect(later.off).toBeGreaterThan(0)              // not suppressed by a miss the skip never wrote
  })
})

describe("cached USDA cannot bypass the stricter degraded identity gate", () => {
  // Reachability finding, recorded deliberately: producing this collision through estimateRecipe
  // is structurally impossible. The USDA positive key embeds foodName, so a replay needs both runs
  // to share it; but a healthy match also requires name similarity with that same foodName (it is
  // 60% of the score), so any candidate healthy accepted necessarily contains the text the degraded
  // gate checks. The revalidation below is therefore defence-in-depth — proven by seeding the cache
  // directly through the real cache API and calling the real provider, rather than by contriving a
  // recipe that cannot exist.
  it("a USDA candidate cached under validated English is rejected before reuse under German-only evidence", async () => {
    const provider = usdaLocalProvider
    // A record that would match under healthy evidence, so "was it replayed?" is observable.
    await useUsdaLocalFixture([{ fdcId: 173474, description: "Wild mint, fresh", kcal: 70, protein: 3.8, carbs: 14.9, fat: 0.9 }])
    // Mirrors the provider's key shape, including the attribute segment added with structured
    // food state and the normalized core food — a bump here must be mirrored, which is the point
    // of asserting it.
    const queryKey = buildQueryKey(`${USDA_CACHE_VERSION}:Bergminze|unknown|generic|unknown/unknown/-|core=mint`, null)
    setCachedProviderMatch("usda-local", queryKey, {
      provider: "usda-local", providerId: "173474", productName: "Wild mint, fresh", brand: null,
      canonicalName: "Bergminze", state: "unknown", dataType: "SR Legacy",
      confidence: 0.6, matchReason: "fuzzy", foodType: "simple",
      nutrients: { kcalPer100g: 70, proteinPer100g: null, carbsPer100g: null, fatPer100g: null,
        saturatedFatPer100g: null, transFatPer100g: null, unsaturatedFatPer100g: null,
        fiberPer100g: null, sugarPer100g: null, sodiumPer100g: null, cholesterolPer100g: null },
    } as any)

    // Healthy evidence: the validated core "mint" IS present in the cached name (whole token) -> reused as-is.
    router({})
    const healthy = await provider.lookup({
      foodName: "Bergminze", structuredName: "Bergminze", brand: null, category: null, state: "unknown",
      foodType: "unknown", coreFoodGerman: null, coreFoodEnglish: "mint", route: "generic",
      evidence: { german: true, english: true, core: true, brand: false },
    } as any)
    expect(healthy?.providerId).toBe("173474")
    expect(healthy?.productName).toBe("Wild mint, fresh") // the CACHED name, replayed as-is

    // Degraded evidence: the gate becomes the structured name "Bergminze", which is absent from
    // "Wild mint, fresh". The entry is now unreachable at TWO layers — the core is part of the
    // key, so a degraded lookup (core "Bergminze") does not even address the healthy row, and the
    // revalidation below would reject it if it did.
    router({})
    const degraded = await provider.lookup({
      foodName: "Bergminze", structuredName: "Bergminze", brand: null, category: null, state: "unknown",
      foodType: "unknown", coreFoodGerman: null, coreFoodEnglish: null, route: "generic",
      evidence: { german: true, english: false, core: false, brand: false },
    } as any)
    // The cached candidate is NOT replayed; the provider re-ranks and finds nothing acceptable
    // under the narrower degraded gate. With no network left, "it re-queried" is observable as
    // "it did not return the cached row".
    expect(degraded).toBeNull()
  })

  it("revalidation still rejects a cached match that the current query's context cannot accept", async () => {
    // foodType and category are context, NOT part of any provider key (see cachedMatchConflict) —
    // so they remain the case that only revalidation can catch, and adding the core to the
    // usda-local key must not quietly retire that check.
    await useUsdaLocalFixture([{ fdcId: 173474, description: "Wild mint, fresh", kcal: 70, protein: 3.8, carbs: 14.9, fat: 0.9 }])
    const queryKey = buildQueryKey(`${USDA_CACHE_VERSION}:Bergminze|unknown|generic|unknown/unknown/-|core=mint`, null)
    setCachedProviderMatch("usda-local", queryKey, {
      provider: "usda-local", providerId: "999999", productName: "Mint chocolate chip ice cream", brand: null,
      canonicalName: "Bergminze", state: "unknown", dataType: "SR Legacy",
      confidence: 0.6, matchReason: "fuzzy", foodType: "composite_dish",
      nutrients: { kcalPer100g: 216, proteinPer100g: null, carbsPer100g: null, fatPer100g: null,
        saturatedFatPer100g: null, transFatPer100g: null, unsaturatedFatPer100g: null,
        fiberPer100g: null, sugarPer100g: null, sodiumPer100g: null, cholesterolPer100g: null },
    } as any)

    router({})
    const match = await usdaLocalProvider.lookup({
      foodName: "Bergminze", structuredName: "Bergminze", brand: null, category: null, state: "unknown",
      foodType: "simple", coreFoodGerman: null, coreFoodEnglish: "mint", route: "generic",
      evidence: { german: true, english: true, core: true, brand: false },
    } as any)
    // Same key, same core — only the foodType differs, and that alone must stop the replay.
    expect(match?.providerId).not.toBe("999999")
  })

  it("a cached usda-local match is replayed for the same core classification and never for another", async () => {
    // --- degraded first: structured English passes the strict structured-name gate
    await useUsdaLocalFixture([{ fdcId: 748608, description: "Olive oil", kcal: 884, fat: 100 }])
    config.llm.enabled = false
    config.llm.apiKey = ""
    router({})
    const r1 = await estimateRecipe(recipe("olive oil", "usda-deg-first"))
    expect(r1!.matchedIngredients[0].provider).toBe("usda-local")
    expect(r1!.matchedIngredients[0].providerId).toBe("748608")

    // --- the SAME question again -> served from cache. The database is swapped for an EMPTY one
    // first, so a second answer of 748608 can only have come from the cache. With no network to
    // count, this is the proof that replaces the old "zero USDA requests" assertion.
    await useEmptyUsdaLocal()
    router({})
    const r2 = await estimateRecipe(recipe("olive oil", "usda-deg-repeat"))
    expect(r2!.matchedIngredients[0].providerId).toBe("748608")

    // --- a healthy lookup classifies the core as "oil" rather than the whole structured name, and
    // that is a different question: the core is part of the usda-local key, so the degraded row is
    // not addressable from here. Reconciling a production discrepancy showed why this matters —
    // the core both gates the match and sets its confidence, so replaying a row found under one
    // core reports a confidence the current core never earned. The cost is fragmentation, which a
    // bundled local database can afford: a miss re-ranks in memory and issues no request.
    config.llm.enabled = true
    config.llm.apiKey = "test-key"
    router({ llm: [classified(0, "Olivenöl", "olive oil", "oil")] })
    const r3 = await estimateRecipe(recipe("olive oil", "usda-deg-then-healthy"))
    expect(r3!.matchedIngredients[0].providerId).not.toBe("748608")
  })
})
