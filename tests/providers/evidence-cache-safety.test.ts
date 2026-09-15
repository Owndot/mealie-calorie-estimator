import { describe, it, expect, beforeEach, beforeAll, vi } from "vitest"
import { estimateRecipe } from "../../src/services/estimator.js"
import { config } from "../../src/config.js"
import { initCache } from "../../src/utils/cache.js"
import { __resetBlsDataForTests, __buildTestBlsData } from "../../src/services/providers/bls-provider.js"
import { createUsdaProviderIfConfigured } from "../../src/services/providers/usda-provider.js"
import { buildQueryKey, setCachedProviderMatch } from "../../src/utils/cache.js"

/** Mirrors USDA_MATCH_ALGORITHM_VERSION; a bump here must be mirrored, which is the point. */
const USDA_CACHE_VERSION = "v15"
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

/** Routes one shared global fetch to whichever upstream the URL belongs to, and counts the calls. */
function router(opts: { llm?: unknown[]; off?: unknown[]; usda?: unknown[] }) {
  const calls = { llm: 0, off: 0, usda: 0 }
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
    if (u.startsWith(config.usda.baseUrl)) {
      calls.usda++
      return new Response(JSON.stringify({ foods: opts.usda ?? [] }), { status: 200, headers: { "content-type": "application/json" } })
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
beforeEach(() => {
  config.usda.apiKey = "test-key"
  config.usda.retryBackoffMs = 1
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
    const provider = createUsdaProviderIfConfigured()!
    const queryKey = buildQueryKey(`${USDA_CACHE_VERSION}:Bergminze|unknown|generic`, null)
    setCachedProviderMatch("usda", queryKey, {
      provider: "usda", providerId: "173474", productName: "Wild mint, fresh", brand: null,
      canonicalName: "Bergminze", state: "unknown", dataType: "SR Legacy",
      confidence: 0.6, matchReason: "fuzzy", foodType: "simple",
      nutrients: { kcalPer100g: 70, proteinPer100g: null, carbsPer100g: null, fatPer100g: null,
        saturatedFatPer100g: null, transFatPer100g: null, unsaturatedFatPer100g: null,
        fiberPer100g: null, sugarPer100g: null, sodiumPer100g: null, cholesterolPer100g: null },
    } as any)

    // Healthy evidence: the validated core "mint" IS present in the cached name (whole token) -> reused as-is.
    const healthyCalls = router({ usda: [] })
    const healthy = await provider.lookup({
      foodName: "Bergminze", structuredName: "Bergminze", brand: null, category: null, state: "unknown",
      foodType: "unknown", coreFoodGerman: null, coreFoodEnglish: "mint", route: "generic",
      evidence: { german: true, english: true, core: true, brand: false },
    } as any)
    expect(healthy?.providerId).toBe("173474")
    expect(healthyCalls.usda).toBe(0) // served from cache

    // Degraded evidence: the gate becomes the structured name "Bergminze", which is absent from
    // "Peppermint, fresh" -> the cached entry is a true cache miss and a fresh lookup happens.
    const degradedCalls = router({ usda: [] })
    const degraded = await provider.lookup({
      foodName: "Bergminze", structuredName: "Bergminze", brand: null, category: null, state: "unknown",
      foodType: "unknown", coreFoodGerman: null, coreFoodEnglish: null, route: "generic",
      evidence: { german: true, english: false, core: false, brand: false },
    } as any)
    expect(degraded).toBeNull()              // cached candidate NOT replayed
    expect(degradedCalls.usda).toBeGreaterThan(0) // it re-queried instead
  })

  it("a degraded structured-English match may be cached and later reused by a healthy lookup", async () => {
    const USDA_HIT = [{ fdcId: 748608, description: "Olive oil", dataType: "SR Legacy", foodNutrients: kcalNutrients(884) }]

    // --- degraded first: structured English passes the strict structured-name gate
    config.llm.enabled = false
    config.llm.apiKey = ""
    const first = router({ usda: USDA_HIT })
    const r1 = await estimateRecipe(recipe("olive oil", "usda-deg-first"))
    expect(first.usda).toBeGreaterThan(0)
    expect(r1!.matchedIngredients[0].provider).toBe("usda")
    expect(r1!.matchedIngredients[0].providerId).toBe("748608")

    // --- healthy afterwards: same query text, still compatible -> served from cache, no new call
    config.llm.enabled = true
    config.llm.apiKey = "test-key"
    const second = router({ llm: [classified(0, "Olivenöl", "olive oil", "oil")], usda: USDA_HIT })
    const r2 = await estimateRecipe(recipe("olive oil", "usda-deg-then-healthy"))
    expect(r2!.matchedIngredients[0].providerId).toBe("748608")
    expect(second.usda).toBe(0)                       // reused, no redundant lookup
  })
})
