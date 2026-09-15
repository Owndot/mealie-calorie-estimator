import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest"
import { OffProvider } from "../../src/services/providers/off-provider.js"
import { initCache } from "../../src/utils/cache.js"
import { config } from "../../src/config.js"

beforeAll(async () => {
  await initCache()
  config.openFoodFacts.retryBackoffMs = 1
})

beforeEach(() => {
  vi.restoreAllMocks()
})

function query(foodName: string, brand: string | null = null) {
  return { foodName, brand, category: null, state: "unknown" as const }
}

function hitsResponse(products: { product_name: string; brands?: string[] | string; nutriments?: Record<string, number> }[]) {
  return new Response(JSON.stringify({ hits: products }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

const MILK_NUTRIMENTS = {
  "energy-kcal_100g": 48,
  "proteins_100g": 3.5,
  "carbohydrates_100g": 5,
  "fat_100g": 1.5,
  "saturated-fat_100g": 1,
}

describe("OffProvider", () => {
  it("never blindly accepts the first hit — ranks multiple candidates and picks the best", async () => {
    const provider = new OffProvider()
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      hitsResponse([
        { product_name: "Autoreifen Winter 205/55", nutriments: { "energy-kcal_100g": 0 } },
        { product_name: "Vollmilch 3.5%", nutriments: MILK_NUTRIMENTS },
      ]),
    )

    const match = await provider.lookup(query("Milch"))
    expect(match?.productName).toBe("Vollmilch 3.5%")
  })

  it("rejects an obvious mismatch (ginger vs ginger ale) and returns null", async () => {
    const provider = new OffProvider()
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      hitsResponse([{ product_name: "Ginger Ale", nutriments: { "energy-kcal_100g": 40 } }]),
    )

    const match = await provider.lookup(query("Ingwer"))
    expect(match).toBeNull()
  })

  it("retries on a 503 and succeeds on a later attempt", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(hitsResponse([{ product_name: "Retrytestmilch", nutriments: MILK_NUTRIMENTS }]))

    const provider = new OffProvider()
    const match = await provider.lookup(query("Retrytestmilch"))

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(match?.nutrients.kcalPer100g).toBe(48)
  })

  it("gives up after exhausting retries on persistent 503", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("unavailable", { status: 503 }))

    const provider = new OffProvider()
    const match = await provider.lookup(query("Exhausttestmilch"))

    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(match).toBeNull()
  })

  it("does NOT poison the negative cache on a transient failure (persistent 5xx) — a later retry can still succeed", async () => {
    const foodName = "Transientfailuretestmilch"

    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("unavailable", { status: 503 }))
    const provider = new OffProvider()

    const failed = await provider.lookup(query(foodName))
    expect(failed).toBeNull()

    // Behavioral proof: a transient failure is not a confirmed "OFF has no hits" — it must not be
    // cached as a miss, or the food would be starved of branded nutrition for a full day even
    // after OFF recovers. A subsequent lookup must still reach the (now-healthy) network.
    vi.restoreAllMocks()
    vi.spyOn(globalThis, "fetch").mockResolvedValue(hitsResponse([{ product_name: foodName, nutriments: MILK_NUTRIMENTS }]))
    const recovered = await provider.lookup(query(foodName))
    expect(recovered?.nutrients.kcalPer100g).toBe(48)
  })

  it("DOES cache a confirmed empty result (OFF reached, zero hits) as a miss", async () => {
    const foodName = "Confirmedemptytestmilch"
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(hitsResponse([]))
    const provider = new OffProvider()

    await provider.lookup(query(foodName))
    // Behavioral proof: a second lookup of the same confirmed-empty query must not hit the
    // network again — served straight from the negative cache.
    await provider.lookup(query(foodName))
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("caches a successful match and does not re-hit the network on a repeat lookup", async () => {
    const foodName = "Cachetestmilch"
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(hitsResponse([{ product_name: foodName, nutriments: MILK_NUTRIMENTS }]))

    const provider = new OffProvider()
    await provider.lookup(query(foodName))
    await provider.lookup(query(foodName))

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("caches a miss (negative cache) and avoids repeat network calls / rate-limit delays for a known-miss query", async () => {
    const foodName = "Negativcachetestmilch"
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(hitsResponse([]))

    const provider = new OffProvider()
    await provider.lookup(query(foodName))
    await provider.lookup(query(foodName))
    expect(fetchMock).toHaveBeenCalledTimes(1) // second call served from the negative cache, no network hit
  })

  it("keys the cache on food name + brand so a branded and a generic lookup of the same food never collide", async () => {
    const foodName = "Poisontestmilch"
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(hitsResponse([{ product_name: foodName, brands: "Brand X", nutriments: MILK_NUTRIMENTS }]))

    const provider = new OffProvider()
    const branded = await provider.lookup(query(foodName, "Brand X"))
    expect(branded).not.toBeNull()

    // Behavioral proof: a generic (no-brand) lookup of the SAME food name must not reuse the
    // branded result from the cache — it has to hit the network again under its own cache key.
    await provider.lookup(query(foodName))
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  describe("brands field as a real OFF search-a-licious response shape (string array) — live acceptance test regression", () => {
    // Found live against the real OFF API: /search actually returns `brands` as a string array
    // (e.g. ["Nutella","Ferrero"], sometimes with empty-string elements), not the single string
    // our type previously assumed. That crashed tokenize() (`s.toLowerCase is not a function`)
    // on every real candidate, silently falling through to the LLM fallback for every branded
    // lookup — caught by nutrient-resolver's try/catch, so the estimate itself didn't error, but
    // OFF was effectively dead for all real traffic. This must never crash the lookup again.

    it("does not crash when brands is a string array (the real shape) and extracts a usable brand", async () => {
      const foodName = "Nutellatestcreme"
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        hitsResponse([{ product_name: foodName, brands: ["Nutella", "Ferrero"], nutriments: MILK_NUTRIMENTS }]),
      )

      const provider = new OffProvider()
      const match = await provider.lookup(query(foodName, "Nutella"))

      expect(match).not.toBeNull()
      expect(match?.brand).toBe("Nutella, Ferrero")
    })

    it("does not crash when the brands array contains an empty-string element (real observed shape)", async () => {
      const foodName = "Jatestmilch"
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        hitsResponse([{ product_name: foodName, brands: ["ja!", ""], nutriments: MILK_NUTRIMENTS }]),
      )

      const provider = new OffProvider()
      const match = await provider.lookup(query(foodName))

      expect(match).not.toBeNull()
      expect(match?.brand).toBe("ja!")
    })

    it("does not crash when brands is entirely empty/missing, and falls back to the query brand", async () => {
      const foodName = "Nobrandtestmilch"
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        hitsResponse([{ product_name: foodName, brands: [], nutriments: MILK_NUTRIMENTS }]),
      )

      const provider = new OffProvider()
      const match = await provider.lookup(query(foodName, "QueryBrand"))

      expect(match).not.toBeNull()
      expect(match?.brand).toBe("QueryBrand")
    })
  })
})

describe("OffProvider — preparation state is part of cache identity (H1 regression)", () => {
  // Found in final review. OFF's ranking is state-sensitive (a candidate whose inferred state
  // conflicts with the query's is rejected), but its cache key was state-blind while BLS's and
  // USDA's were not. A cache hit re-validates nothing except nutrient plausibility
  // (nutrient-resolver.ts), so a match cached for one state was returned verbatim for another:
  // fresh parsley (~36 kcal/100g) served for a dried-parsley query (~292 kcal/100g) whenever both
  // normalized to the same canonicalEnglish text.
  const FRESH_PARSLEY = {
    product_name: "Parsley fresh h1statekey",
    nutriments: { "energy-kcal_100g": 36, "proteins_100g": 3, "carbohydrates_100g": 6, "fat_100g": 0.8 },
  }

  function stateQuery(state: "raw" | "dried") {
    return {
      foodName: "parsley h1statekey",
      brand: null,
      category: "herb",
      state,
      foodType: "simple" as const,
      coreFoodEnglish: "parsley",
    }
  }

  it("does not serve a match cached under one state to a query with a different state", async () => {
    const provider = new OffProvider()
    // Fresh Response per call: a Response body can only be read once, and this test issues two lookups.
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => hitsResponse([FRESH_PARSLEY]))

    const raw = await provider.lookup(stateQuery("raw"))
    expect(raw?.productName).toBe("Parsley fresh h1statekey")
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const dried = await provider.lookup(stateQuery("dried"))

    // A second network call proves the two states no longer share a cache slot. Before the fix
    // this was 1 call and `dried` was the cached FRESH match.
    expect(fetchMock).toHaveBeenCalledTimes(2)
    // And on that fresh lookup the state conflict rejects the fresh candidate outright.
    expect(dried).toBeNull()
  })

  it("still reuses the cache for a repeated lookup with the SAME state", async () => {
    const provider = new OffProvider()
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      hitsResponse([{ product_name: "Parsley fresh h1samestate", nutriments: FRESH_PARSLEY.nutriments }]),
    )

    const q = { ...stateQuery("raw"), foodName: "parsley h1samestate" }
    const first = await provider.lookup(q)
    const second = await provider.lookup(q)

    expect(first?.productName).toBe("Parsley fresh h1samestate")
    expect(second?.productName).toBe("Parsley fresh h1samestate")
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
