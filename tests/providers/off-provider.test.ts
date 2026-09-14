import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest"
import { OffProvider } from "../../src/services/providers/off-provider.js"
import { initCache, buildQueryKey, getCachedProviderMatch, isProviderMiss } from "../../src/utils/cache.js"
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

function hitsResponse(products: { product_name: string; brands?: string; nutriments?: Record<string, number> }[]) {
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
    expect(isProviderMiss("off", buildQueryKey(foodName, null))).toBe(true)

    await provider.lookup(query(foodName))
    expect(fetchMock).toHaveBeenCalledTimes(1) // second call served from the negative cache, no network hit
  })

  it("keys the cache on food name + brand so a branded and a generic lookup of the same food never collide", async () => {
    const foodName = "Poisontestmilch"
    vi.spyOn(globalThis, "fetch").mockResolvedValue(hitsResponse([{ product_name: foodName, brands: "Brand X", nutriments: MILK_NUTRIMENTS }]))

    const provider = new OffProvider()
    await provider.lookup(query(foodName, "Brand X"))

    expect(getCachedProviderMatch("off", buildQueryKey(foodName, "Brand X"))).toBeDefined()
    expect(getCachedProviderMatch("off", buildQueryKey(foodName, null))).toBeUndefined()
  })
})
