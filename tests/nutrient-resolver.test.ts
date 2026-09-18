import { describe, it, expect, beforeEach, afterEach, vi, beforeAll } from "vitest"
import { resolveNutrients } from "../src/services/nutrient-resolver.js"
import { initCache } from "../src/utils/cache.js"
import { __buildTestBlsData, __resetBlsDataForTests } from "../src/services/providers/bls-provider.js"
import { config } from "../src/config.js"
import { useUsdaLocalFixture, useEmptyUsdaLocal, resetUsdaLocalFixture } from "./helpers/usda-local-fixture.js"
import { providerQuery } from "./helpers/provider-query.js"

beforeAll(async () => {
  await initCache()
})

beforeEach(() => {
  config.llm.enabled = false
  config.llm.apiKey = ""
  vi.restoreAllMocks()
  // BLS is unconditionally in the generic chain (real bundled data) — give every test a
  // controlled, empty dataset so only the specific mocks/config each test sets up decide the
  // outcome, rather than depending on what the real 7,140-row export happens to contain.
  __resetBlsDataForTests(Promise.resolve(__buildTestBlsData([])))
})

afterEach(() => {
  resetUsdaLocalFixture()
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

    const result = await resolveNutrients(providerQuery({ foodName: "Weizenmehl" }), "generic")
    expect(result).toBeNull()
  })

  it("resolves a generic food from the local USDA database, with accurate provenance", async () => {
    // USDA is a bundled file now, so the seam is a controlled DATABASE rather than a stubbed
    // search response — the provider's real load, retrieval, ranking and gating all run.
    await useUsdaLocalFixture([
      { fdcId: 999111, description: "Resolvertest Flour", kcal: 364, protein: 10, carbs: 76, fat: 1 },
    ])

    const result = await resolveNutrients(providerQuery({ foodName: "Resolvertest Flour" }), "generic")

    expect(result?.fallbackStatus).toBe("usda-local")
    expect(result?.match.provider).toBe("usda-local")
    expect(result?.match.providerId).toBe("999111")
    expect(result?.match.productName).toBe("Resolvertest Flour")
    expect(result?.match.dataType).toBe("SR Legacy")
  })

  it("does not reach OFF when USDA local already produced an acceptable match", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ hits: [{ product_name: "Resolvertest Sugar", brands: [], categories_tags: [], nutriments: { "energy-kcal_100g": 387, "proteins_100g": 0, "carbohydrates_100g": 100, "fat_100g": 0 } }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    )

    await resolveNutrients(providerQuery({ foodName: "Resolvertest Sugar" }), "generic")

    // Every fetched URL must be an Open Food Facts one — USDA must never be reached once OFF
    // already produced an acceptable match earlier in the chain.
    for (const call of fetchMock.mock.calls) {
      expect(String(call[0])).toContain("openfoodfacts")
      expect(String(call[0])).not.toContain("api.nal.usda.gov")
    }
  })

  it("returns null when no provider resolves the query, rather than fabricating a match", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (String(url).includes("openfoodfacts")) {
        return new Response(JSON.stringify({ hits: [] }), { status: 200, headers: { "content-type": "application/json" } })
      }
      return new Response(JSON.stringify({ foods: [] }), { status: 200 })
    })

    const result = await resolveNutrients(providerQuery({ foodName: "Resolvertestnonexistent" }), "generic")
    expect(result).toBeNull()
  })
})
