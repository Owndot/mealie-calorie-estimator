import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest"
import { config } from "../src/config.js"
import type { ProviderMatch } from "../src/types.js"
import { UNKNOWN_ATTRIBUTES } from "../src/types.js"

/**
 * A USDA match that the CURRENT algorithm could not produce must not stay usable because an older
 * algorithm cached it.
 *
 * v1.0.4 made retrieval fail closed on an empty constraint set — but that check lives inside
 * retrieve(), and lookup() reads provider_match_cache first and returns on a hit. So production
 * kept serving a row written by the old fail-open build:
 *
 *   provider: usda-local   query_key: "v2 1 ei unknown generic unknown unknown core ei|"
 *   provider_id: 325658    product_name: Sausage, Italian, pork, mild, cooked, pan-fried
 *   kcalPer100g: 322       confidence: 0.8
 *
 * which produced 1 Stück Ei -> 322 kcal/100 g x 53 g = 170.66 kcal on a fully patched v1.0.4.
 *
 * Note this is NOT the BLS cache-poisoning shape and the BLS remedy would not have caught it:
 * that sausage is nutritionally self-consistent (322 kcal vs 317 by Atwater), so re-checking
 * plausibility on read passes it. The defect is a match the current algorithm cannot produce.
 */

const cacheReads: string[] = []

vi.mock("../src/utils/cache.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils/cache.js")>()
  return {
    ...actual,
    getCachedProviderMatch: vi.fn((provider: string, key: string) => {
      if (provider === "usda-local") cacheReads.push(key)
      return actual.getCachedProviderMatch(provider, key)
    }),
  }
})

/** The exact row from the production cache dump. */
const SAUSAGE: ProviderMatch = {
  nutrients: {
    kcalPer100g: 322, proteinPer100g: 18.2, carbsPer100g: 2.15, fatPer100g: 26.2,
    saturatedFatPer100g: 9.15, transFatPer100g: 0.1, unsaturatedFatPer100g: null,
    fiberPer100g: null, sugarPer100g: 1.46, sodiumPer100g: 0.766, cholesterolPer100g: 0.08,
  },
  canonicalName: "Ei", brand: null, state: "unknown",
  provider: "usda-local", providerId: "325658",
  productName: "Sausage, Italian, pork, mild, cooked, pan-fried",
  confidence: 0.8, dataType: "Foundation", foodType: "simple", matchReason: "fuzzy",
}

const PRODUCTION_KEY = "v2 1 ei unknown generic unknown unknown core ei|"

beforeAll(async () => {
  const { initCache } = await import("../src/utils/cache.js")
  await initCache()
})

beforeEach(() => {
  cacheReads.length = 0
  config.llm.enabled = false
  config.llm.apiKey = ""
  config.llm.judgeEnabled = false
})

async function resolve(foodName: string) {
  const { buildResolverQuery } = await import("../src/services/resolver-query.js")
  const { resolveNutrients } = await import("../src/services/nutrient-resolver.js")
  const { query, route } = buildResolverQuery(foodName, undefined, {})
  return resolveNutrients(query, route)
}

describe("an upgraded installation with a poisoned USDA cache", () => {
  it("does not serve the cached sausage for 'Ei' (the exact production row)", async () => {
    const cache = await import("../src/utils/cache.js")
    cache.setCachedProviderMatch("usda-local", PRODUCTION_KEY, SAUSAGE)
    expect(cache.getCachedProviderMatch("usda-local", PRODUCTION_KEY)?.providerId).toBe("325658")

    const resolved = await resolve("Ei")

    expect(resolved?.match.providerId).not.toBe("325658")
    // The poisoned cache row must never be served. A curated vocabulary row may answer, because it
    // names one reviewed record directly and never reads the provider cache.
    if (resolved?.match.provider === "usda-local") {
      expect(resolved.match.matchReason).toMatch(/^recipe-vocabulary:/)
    }
  })

  it("never consults the USDA cache at all for an unconstrained query", async () => {
    // The strongest form of the invariant, and independent of the algorithm-version bump: if the
    // provider cannot answer, it must decide that BEFORE the cache, so no stored row — under any
    // key, written by any past or future algorithm — can re-enter through a path the invariant
    // does not see.
    cacheReads.length = 0
    await resolve("Ei")
    expect(cacheReads, "USDA read its cache for a query it cannot answer").toEqual([])

    cacheReads.length = 0
    await resolve("Zz")
    expect(cacheReads).toEqual([])
  })

  it("the provider declines directly, with a poisoned row present under any key", async () => {
    const { usdaLocalProvider } = await import("../src/services/providers/usda-local-provider.js")
    const { buildResolverQuery } = await import("../src/services/resolver-query.js")
    const cache = await import("../src/utils/cache.js")

    cache.setCachedProviderMatch("usda-local", PRODUCTION_KEY, SAUSAGE)
    const { query } = buildResolverQuery("Ei", undefined, {})
    const match = await usdaLocalProvider.lookup({ ...query, attributes: UNKNOWN_ATTRIBUTES })

    expect(match).toBeNull()
  })

  it("still consults the cache for a query it CAN answer", async () => {
    cacheReads.length = 0
    const resolved = await resolve("black beans")
    expect(cacheReads.length).toBeGreaterThan(0)
    expect(resolved!.match.providerId).toBe("173734")
  })
})

describe("the v1.0.4 invariants are preserved", () => {
  it("cold-cache 'Ei', 'Zz' and 'Aa' resolve to nothing", async () => {
    for (const junk of ["Ei", "Zz", "Aa"]) {
      const r = await resolve(junk)
      if (r?.match.provider === "usda-local") expect(r.match.matchReason).toMatch(/^recipe-vocabulary:/)
    }
    expect(await resolve("Zz")).toBeNull()
    expect(await resolve("Aa")).toBeNull()
  })

  it("'black beans' is unchanged and BLS-first resolution is unchanged", async () => {
    const beans = await resolve("black beans")
    expect(beans!.match.provider).toBe("usda-local")
    expect(beans!.match.providerId).toBe("173734")

    for (const [name, id] of [["Kartoffeln", "K110100"], ["Olivenöl", "Q120000"], ["Hühnerei", "E111100"], ["Wasser", "N110000"]] as const) {
      const r = await resolve(name)
      expect(r!.match.provider).toBe("bls")
      expect(r!.match.providerId).toBe(id)
    }
  })

  it("a valid cached USDA match is still reused", async () => {
    const first = await resolve("Ground Cumin")
    const second = await resolve("Ground Cumin")
    expect(first!.match.providerId).toBe(second!.match.providerId)
    expect(second!.match.provider).toBe("usda-local")
  })
})
