import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest"
import { UsdaProvider, createUsdaProviderIfConfigured } from "../../src/services/providers/usda-provider.js"
import { initCache, buildQueryKey, getCachedProviderMatch } from "../../src/utils/cache.js"
import { config } from "../../src/config.js"

beforeAll(async () => {
  await initCache()
  config.usda.retryBackoffMs = 1
})

beforeEach(() => {
  vi.restoreAllMocks()
  config.usda.apiKey = "test-key"
})

function query(foodName: string) {
  return { foodName, brand: null, category: null, state: "unknown" as const }
}

function fdcResponse(foods: { description: string; fdcId: number; foodNutrients: { nutrientId: number; nutrientName: string; unitName: string; value: number }[] }[]) {
  return new Response(JSON.stringify({ foods }), { status: 200, headers: { "content-type": "application/json" } })
}

const CHICKEN_NUTRIENTS = [
  { nutrientId: 1008, nutrientName: "Energy", unitName: "KCAL", value: 165 },
  { nutrientId: 1003, nutrientName: "Protein", unitName: "G", value: 31 },
  { nutrientId: 1005, nutrientName: "Carbohydrate, by difference", unitName: "G", value: 0 },
  { nutrientId: 1004, nutrientName: "Total lipid (fat)", unitName: "G", value: 3.6 },
  { nutrientId: 1093, nutrientName: "Sodium, Na", unitName: "MG", value: 74 },
  { nutrientId: 1253, nutrientName: "Cholesterol", unitName: "MG", value: 85 },
]

describe("createUsdaProviderIfConfigured", () => {
  it("returns null when USDA_API_KEY is not set — no dummy placeholder", () => {
    config.usda.apiKey = ""
    expect(createUsdaProviderIfConfigured()).toBeNull()
  })

  it("returns a real provider instance when configured", () => {
    config.usda.apiKey = "test-key"
    expect(createUsdaProviderIfConfigured()).not.toBeNull()
  })
})

describe("UsdaProvider", () => {
  it("resolves a food and converts sodium/cholesterol from USDA's mg to internal grams", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      fdcResponse([{ description: "Chicken, breast", fdcId: 12345, foodNutrients: CHICKEN_NUTRIENTS }]),
    )

    const provider = new UsdaProvider()
    const match = await provider.lookup(query("Chicken, breast"))

    expect(match?.nutrients.kcalPer100g).toBe(165)
    expect(match?.nutrients.sodiumPer100g).toBeCloseTo(0.074)
    expect(match?.nutrients.cholesterolPer100g).toBeCloseTo(0.085)
    expect(match?.providerId).toBe("12345")
  })

  it("ranks candidates and rejects obvious mismatches", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      fdcResponse([{ description: "Ginger Ale", fdcId: 1, foodNutrients: [{ nutrientId: 1008, nutrientName: "Energy", unitName: "KCAL", value: 40 }] }]),
    )

    const provider = new UsdaProvider()
    const match = await provider.lookup(query("Ingwer"))
    expect(match).toBeNull()
  })

  it("caches results", async () => {
    const foodName = "Usdacachetest"
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(fdcResponse([{ description: foodName, fdcId: 999, foodNutrients: CHICKEN_NUTRIENTS }]))

    const provider = new UsdaProvider()
    await provider.lookup(query(foodName))
    await provider.lookup(query(foodName))

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(getCachedProviderMatch("usda", buildQueryKey(foodName, null))).toBeDefined()
  })

  it("returns null on a failed request", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("error", { status: 500 }))
    const provider = new UsdaProvider()
    const match = await provider.lookup(query("Usdafailtest"))
    expect(match).toBeNull()
  })
})
