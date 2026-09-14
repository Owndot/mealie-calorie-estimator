import { describe, it, expect, beforeEach, vi, beforeAll } from "vitest"
import { resolveNutrients } from "../src/services/nutrient-resolver.js"
import { initCache } from "../src/utils/cache.js"
import { __buildTestBlsData, __resetBlsDataForTests } from "../src/services/providers/bls-provider.js"
import { config } from "../src/config.js"

beforeAll(async () => {
  await initCache()
})

beforeEach(() => {
  config.usda.apiKey = ""
  config.llm.enabled = false
  config.llm.apiKey = ""
  vi.restoreAllMocks()
  // BLS is unconditionally in the generic chain (real bundled data) — give every test a
  // controlled, empty dataset so only the specific mocks/config each test sets up decide the
  // outcome, rather than depending on what the real 7,140-row export happens to contain.
  __resetBlsDataForTests(Promise.resolve(__buildTestBlsData([])))
})

function fdcResponse(description: string, fdcId: number) {
  return new Response(
    JSON.stringify({
      foods: [
        {
          description,
          fdcId,
          foodNutrients: [
            { nutrientId: 1008, nutrientName: "Energy", unitName: "KCAL", value: 364 },
            { nutrientId: 1003, nutrientName: "Protein", unitName: "G", value: 10 },
            { nutrientId: 1005, nutrientName: "Carbohydrate, by difference", unitName: "G", value: 76 },
            { nutrientId: 1004, nutrientName: "Total lipid (fat)", unitName: "G", value: 1 },
          ],
        },
      ],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  )
}

describe("resolveNutrients", () => {
  it("returns null when BLS/OFF find nothing and USDA is unconfigured — no hand-authored data fills the gap", async () => {
    // BLS is emptied by beforeEach; USDA is unconfigured (apiKey ""); OFF (unconditionally in the
    // generic chain as an optional final DB fallback) must be given a controlled empty response
    // rather than hitting the real network in a test.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ hits: [] }), { status: 200, headers: { "content-type": "application/json" } }))

    const result = await resolveNutrients({ foodName: "Weizenmehl", brand: null, category: null, state: "unknown" }, "generic")
    expect(result).toBeNull()
  })

  it("resolves a generic food via the real USDA provider when configured, with accurate provenance", async () => {
    // OFF now precedes USDA in the generic chain — give OFF an empty-hits response and USDA the
    // real fixture, keyed by URL (each fetch() call needs a fresh Response; the body stream can
    // only be read once, so a single shared mockResolvedValue would break the second caller).
    config.usda.apiKey = "test-key"
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (String(url).includes("openfoodfacts")) {
        return new Response(JSON.stringify({ hits: [] }), { status: 200, headers: { "content-type": "application/json" } })
      }
      return fdcResponse("Resolvertest Flour", 999111)
    })

    const result = await resolveNutrients({ foodName: "Resolvertest Flour", brand: null, category: null, state: "unknown" }, "generic")

    expect(result?.fallbackStatus).toBe("usda")
    expect(result?.match.provider).toBe("usda")
    expect(result?.match.providerId).toBe("999111")
    expect(result?.match.productName).toBe("Resolvertest Flour")
  })

  it("does not query USDA when BLS/OFF already produced an acceptable match (USDA is not tried on every generic food)", async () => {
    config.usda.apiKey = "test-key"
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ hits: [{ product_name: "Resolvertest Sugar", brands: [], categories_tags: [], nutriments: { "energy-kcal_100g": 387, "proteins_100g": 0, "carbohydrates_100g": 100, "fat_100g": 0 } }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    )

    await resolveNutrients({ foodName: "Resolvertest Sugar", brand: null, category: null, state: "unknown" }, "generic")

    // Every fetched URL must be an Open Food Facts one — USDA must never be reached once OFF
    // already produced an acceptable match earlier in the chain.
    for (const call of fetchMock.mock.calls) {
      expect(String(call[0])).toContain("openfoodfacts")
      expect(String(call[0])).not.toContain("api.nal.usda.gov")
    }
  })

  it("returns null when no provider resolves the query, rather than fabricating a match", async () => {
    config.usda.apiKey = "test-key"
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (String(url).includes("openfoodfacts")) {
        return new Response(JSON.stringify({ hits: [] }), { status: 200, headers: { "content-type": "application/json" } })
      }
      return new Response(JSON.stringify({ foods: [] }), { status: 200 })
    })

    const result = await resolveNutrients({ foodName: "Resolvertestnonexistent", brand: null, category: null, state: "unknown" }, "generic")
    expect(result).toBeNull()
  })
})
