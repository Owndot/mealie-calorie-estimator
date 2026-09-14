import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest"
import { UsdaProvider, createUsdaProviderIfConfigured } from "../../src/services/providers/usda-provider.js"
import { initCache } from "../../src/utils/cache.js"
import { config } from "../../src/config.js"
import type { ProviderQuery } from "../../src/services/providers/types.js"

beforeAll(async () => {
  await initCache()
  config.usda.retryBackoffMs = 1
})

beforeEach(() => {
  vi.restoreAllMocks()
  config.usda.apiKey = "test-key"
})

function query(foodName: string, overrides: Partial<ProviderQuery> = {}): ProviderQuery {
  return { foodName, brand: null, category: null, state: "unknown", route: "generic", ...overrides }
}

interface FdcFoodFixture {
  description: string
  fdcId: number
  dataType?: string
  brandOwner?: string
  foodNutrients: { nutrientId: number; nutrientName: string; unitName: string; value: number }[]
}

function fdcResponse(foods: FdcFoodFixture[]) {
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

describe("UsdaProvider — basic resolution", () => {
  it("resolves a food and converts sodium/cholesterol from USDA's mg to internal grams", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      fdcResponse([{ description: "Chicken, breast", fdcId: 12345, dataType: "Foundation", foodNutrients: CHICKEN_NUTRIENTS }]),
    )

    const provider = new UsdaProvider()
    const match = await provider.lookup(query("Chicken, breast"))

    expect(match?.nutrients.kcalPer100g).toBe(165)
    expect(match?.nutrients.sodiumPer100g).toBeCloseTo(0.074)
    expect(match?.nutrients.cholesterolPer100g).toBeCloseTo(0.085)
    expect(match?.providerId).toBe("12345")
  })

  it("ranks candidates and rejects obvious mismatches (findMismatch)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      fdcResponse([{ description: "Ginger Ale", fdcId: 1, dataType: "Branded", foodNutrients: [{ nutrientId: 1008, nutrientName: "Energy", unitName: "KCAL", value: 40 }] }]),
    )

    const provider = new UsdaProvider()
    const match = await provider.lookup(query("Ingwer"))
    expect(match).toBeNull()
  })

  it("caches results — a second identical lookup does not refetch", async () => {
    const foodName = "Usdacachetest"
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(fdcResponse([{ description: foodName, fdcId: 999, dataType: "Foundation", foodNutrients: CHICKEN_NUTRIENTS }]))

    const provider = new UsdaProvider()
    const first = await provider.lookup(query(foodName))
    const second = await provider.lookup(query(foodName))

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(first?.providerId).toBe("999")
    expect(second?.providerId).toBe("999")
  })

  it("does not reuse a cached match across a state change — same food name, different state, must refetch", async () => {
    const foodName = "Usdastatecachetest"
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(fdcResponse([{ description: foodName, fdcId: 998, dataType: "Foundation", foodNutrients: CHICKEN_NUTRIENTS }]))

    const provider = new UsdaProvider()
    await provider.lookup(query(foodName, { state: "raw" }))
    await provider.lookup(query(foodName, { state: "cooked" }))

    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("returns null on a failed request", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("error", { status: 500 }))
    const provider = new UsdaProvider()
    const match = await provider.lookup(query("Usdafailtest"))
    expect(match).toBeNull()
  })
})

describe("UsdaProvider — never trusts foods[0] / dataType ranking", () => {
  it("real-shape failure case: a Branded product literally named the query wins the raw text-search order, but the generic route must pick the genuine generic entry instead", async () => {
    // Verified live against the real API: query=banana returns a Branded product named "BANANA"
    // as foods[0], ahead of any genuine raw-banana entry. This is the exact shape of that response.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      fdcResponse([
        { description: "BANANA", fdcId: 1, dataType: "Branded", brandOwner: "Generic Brand Co", foodNutrients: [{ nutrientId: 1008, nutrientName: "Energy", unitName: "KCAL", value: 90 }] },
        { description: "Bananas, raw", fdcId: 2, dataType: "SR Legacy", foodNutrients: [{ nutrientId: 1008, nutrientName: "Energy", unitName: "KCAL", value: 89 }] },
      ]),
    )

    const provider = new UsdaProvider()
    const match = await provider.lookup(query("banana"))

    expect(match?.providerId).toBe("2")
    expect(match?.dataType).toBe("SR Legacy")
  })

  it("excludes Branded results entirely on the generic route, even when it's the only candidate", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      fdcResponse([{ description: "Banana Flavored Spread", fdcId: 5, dataType: "Branded", foodNutrients: [{ nutrientId: 1008, nutrientName: "Energy", unitName: "KCAL", value: 300 }] }]),
    )

    const provider = new UsdaProvider()
    const match = await provider.lookup(query("banana only-branded-available", { route: "generic" }))
    expect(match).toBeNull()
  })

  it("allows a Branded result on the branded route when brand evidence is compatible", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      fdcResponse([{ description: "Nutella Hazelnut Spread", fdcId: 6, dataType: "Branded", brandOwner: "Ferrero", foodNutrients: CHICKEN_NUTRIENTS }]),
    )

    const provider = new UsdaProvider()
    const match = await provider.lookup(query("Nutella Hazelnut Spread", { route: "branded", brand: "Ferrero" }))
    expect(match).not.toBeNull()
    expect(match?.dataType).toBe("Branded")
  })

  it("prefers Foundation over SR Legacy over Survey (FNDDS) when name similarity ties", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      fdcResponse([
        { description: "Apple, raw", fdcId: 10, dataType: "Survey (FNDDS)", foodNutrients: CHICKEN_NUTRIENTS },
        { description: "Apple, raw", fdcId: 11, dataType: "SR Legacy", foodNutrients: CHICKEN_NUTRIENTS },
        { description: "Apple, raw", fdcId: 12, dataType: "Foundation", foodNutrients: CHICKEN_NUTRIENTS },
      ]),
    )

    const provider = new UsdaProvider()
    const match = await provider.lookup(query("Apple, raw"))
    expect(match?.providerId).toBe("12")
    expect(match?.dataType).toBe("Foundation")
  })

  it("a Foundation result with the wrong food identity is still rejected — dataType is one signal, not the only one", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      fdcResponse([{ description: "Ginger Ale", fdcId: 20, dataType: "Foundation", foodNutrients: CHICKEN_NUTRIENTS }]),
    )

    const provider = new UsdaProvider()
    const match = await provider.lookup(query("Ingwer"))
    expect(match).toBeNull()
  })
})

describe("UsdaProvider — state and category conflict rejection", () => {
  it("rejects a candidate whose inferred state conflicts with the query's known state (raw vs cooked)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      fdcResponse([{ description: "Potato Conflict Test, boiled", fdcId: 30, dataType: "Foundation", foodNutrients: CHICKEN_NUTRIENTS }]),
    )

    const provider = new UsdaProvider()
    const match = await provider.lookup(query("Potato Conflict Test", { state: "raw" }))
    expect(match).toBeNull()
  })

  it("accepts a candidate whose inferred state agrees with the query's known state", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      fdcResponse([{ description: "Potato Agree Test, raw", fdcId: 31, dataType: "Foundation", foodNutrients: CHICKEN_NUTRIENTS }]),
    )

    const provider = new UsdaProvider()
    const match = await provider.lookup(query("Potato Agree Test", { state: "raw" }))
    expect(match?.providerId).toBe("31")
  })

  it("rejects a strict raw-ingredient category candidate that looks like a composite/manufactured product", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      fdcResponse([{ description: "Paprika Sausage", fdcId: 40, dataType: "Branded", foodNutrients: CHICKEN_NUTRIENTS }]),
    )

    const provider = new UsdaProvider()
    const match = await provider.lookup(query("Paprika", { category: "spice", route: "branded" }))
    expect(match).toBeNull()
  })
})

describe("UsdaProvider — nutrient mapping by stable ID, not array position or kJ", () => {
  it("reads energy from nutrientId 1008 (kcal) even when 1062 (kJ) is also present, never confusing the two", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      fdcResponse([{
        description: "Testfood50",
        fdcId: 50,
        dataType: "Foundation",
        foodNutrients: [
          { nutrientId: 1062, nutrientName: "Energy", unitName: "kJ", value: 690 }, // kJ entry listed FIRST
          { nutrientId: 1008, nutrientName: "Energy", unitName: "KCAL", value: 165 },
          { nutrientId: 1003, nutrientName: "Protein", unitName: "G", value: 31 },
        ],
      }]),
    )

    const provider = new UsdaProvider()
    const match = await provider.lookup(query("Testfood50"))
    expect(match?.nutrients.kcalPer100g).toBe(165) // not 690
  })

  it("maps saturated fat and trans fat by ID, never confusing them with total fat", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      fdcResponse([{
        description: "Testfood51",
        fdcId: 51,
        dataType: "Foundation",
        foodNutrients: [
          { nutrientId: 1008, nutrientName: "Energy", unitName: "KCAL", value: 300 },
          { nutrientId: 1004, nutrientName: "Total lipid (fat)", unitName: "G", value: 20 },
          { nutrientId: 1258, nutrientName: "Fatty acids, total saturated", unitName: "G", value: 8 },
          { nutrientId: 1257, nutrientName: "Fatty acids, total trans", unitName: "G", value: 1.5 },
        ],
      }]),
    )

    const provider = new UsdaProvider()
    const match = await provider.lookup(query("Testfood51"))
    expect(match?.nutrients.fatPer100g).toBe(20)
    expect(match?.nutrients.saturatedFatPer100g).toBe(8)
    expect(match?.nutrients.transFatPer100g).toBe(1.5)
    expect(match?.nutrients.unsaturatedFatPer100g).toBeCloseTo(10.5) // 20 - 8 - 1.5
  })

  it("maps fiber and total sugars by ID", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      fdcResponse([{
        description: "Testfood52",
        fdcId: 52,
        dataType: "Foundation",
        foodNutrients: [
          { nutrientId: 1008, nutrientName: "Energy", unitName: "KCAL", value: 100 },
          { nutrientId: 1079, nutrientName: "Fiber, total dietary", unitName: "G", value: 4 },
          { nutrientId: 2000, nutrientName: "Sugars, total including NLEA", unitName: "G", value: 12 },
        ],
      }]),
    )

    const provider = new UsdaProvider()
    const match = await provider.lookup(query("Testfood52"))
    expect(match?.nutrients.fiberPer100g).toBe(4)
    expect(match?.nutrients.sugarPer100g).toBe(12)
  })

  it("leaves a nutrient unknown (null), never 0, when USDA doesn't report it at all", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      fdcResponse([{
        description: "Testfood53",
        fdcId: 53,
        dataType: "Foundation",
        foodNutrients: [{ nutrientId: 1008, nutrientName: "Energy", unitName: "KCAL", value: 50 }], // nothing else reported
      }]),
    )

    const provider = new UsdaProvider()
    const match = await provider.lookup(query("Testfood53"))
    expect(match?.nutrients.fiberPer100g).toBeNull()
    expect(match?.nutrients.sodiumPer100g).toBeNull()
    expect(match?.nutrients.transFatPer100g).toBeNull()
  })
})

describe("UsdaProvider — provenance", () => {
  it("persists FDC ID, selected description (as productName), dataType, and confidence", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      fdcResponse([{ description: "Testfood60, raw", fdcId: 60, dataType: "Foundation", foodNutrients: CHICKEN_NUTRIENTS }]),
    )

    const provider = new UsdaProvider()
    const match = await provider.lookup(query("Testfood60"))

    expect(match?.provider).toBe("usda")
    expect(match?.providerId).toBe("60")
    expect(match?.productName).toBe("Testfood60, raw")
    expect(match?.dataType).toBe("Foundation")
    expect(match?.confidence).toBeGreaterThan(0)
    expect(match?.confidence).toBeLessThanOrEqual(1)
  })

  it("never stores the API key anywhere in the match", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      fdcResponse([{ description: "Testfood61", fdcId: 61, dataType: "Foundation", foodNutrients: CHICKEN_NUTRIENTS }]),
    )

    const provider = new UsdaProvider()
    const match = await provider.lookup(query("Testfood61"))
    const serialized = JSON.stringify(match)
    expect(serialized).not.toContain(config.usda.apiKey)
  })
})

describe("UsdaProvider — negative cache safety", () => {
  it("a transient network failure does NOT poison the negative cache", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"))
    const provider = new UsdaProvider()
    const foodName = "Usdatransienttest"

    await provider.lookup(query(foodName))

    // Behavioral proof: a subsequent call still hits the network again (not short-circuited by a
    // cached miss) once the transient failure is fixed.
    vi.restoreAllMocks()
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      fdcResponse([{ description: foodName, fdcId: 70, dataType: "Foundation", foodNutrients: CHICKEN_NUTRIENTS }]),
    )
    const match = await provider.lookup(query(foodName))
    expect(match?.providerId).toBe("70")
  })

  it("a confirmed empty result set (real no-match) IS negative cached — a second lookup does not refetch", async () => {
    const foodName = "Usdaconfirmedmisstest"
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(fdcResponse([]))

    const provider = new UsdaProvider()
    await provider.lookup(query(foodName))
    const secondCallCount = fetchMock.mock.calls.length
    await provider.lookup(query(foodName))

    expect(fetchMock.mock.calls.length).toBe(secondCallCount) // no additional fetch on the second call
  })

  it("a malformed (non-JSON) response does NOT poison the negative cache", async () => {
    const foodName = "Usdamalformedtest"
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("not json", { status: 200, headers: { "content-type": "application/json" } }))

    const provider = new UsdaProvider()
    await provider.lookup(query(foodName))

    vi.restoreAllMocks()
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      fdcResponse([{ description: foodName, fdcId: 71, dataType: "Foundation", foodNutrients: CHICKEN_NUTRIENTS }]),
    )
    const match = await provider.lookup(query(foodName))
    expect(match?.providerId).toBe("71") // proves the earlier malformed response wasn't cached as a miss
  })
})

describe("UsdaProvider — never sees originalText", () => {
  it("the search query is built only from ProviderQuery.foodName/brand — originalText has no field to travel through", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(fdcResponse([]))

    const provider = new UsdaProvider()
    // ProviderQuery has no originalText field at all — this is a structural guarantee, but the
    // regression check still verifies the actual outgoing request text contains only what was
    // explicitly passed.
    await provider.lookup(query("Ei", { brand: null }))

    const requestedUrl = String(fetchMock.mock.calls[0][0])
    expect(requestedUrl).toContain(encodeURIComponent("Ei"))
    expect(requestedUrl).not.toContain("organicvalley")
    expect(requestedUrl).not.toContain("gekocht")
  })
})
