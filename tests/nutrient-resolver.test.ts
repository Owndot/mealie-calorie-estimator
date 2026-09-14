import { describe, it, expect, beforeEach, vi, beforeAll } from "vitest"
import { resolveNutrients } from "../src/services/nutrient-resolver.js"
import { initCache } from "../src/utils/cache.js"
import { config } from "../src/config.js"

beforeAll(async () => {
  await initCache()
})

beforeEach(() => {
  config.usda.apiKey = ""
  config.llm.enabled = false
  config.llm.apiKey = ""
  vi.restoreAllMocks()
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
  it("returns null when no provider is configured for the generic route — no hand-authored data fills the gap", async () => {
    const result = await resolveNutrients({ foodName: "Weizenmehl", brand: null, category: null, state: "unknown" }, "generic")
    expect(result).toBeNull()
  })

  it("resolves a generic food via the real USDA provider when configured, with accurate provenance", async () => {
    config.usda.apiKey = "test-key"
    vi.spyOn(globalThis, "fetch").mockResolvedValue(fdcResponse("Resolvertest Flour", 999111))

    const result = await resolveNutrients({ foodName: "Resolvertest Flour", brand: null, category: null, state: "unknown" }, "generic")

    expect(result?.fallbackStatus).toBe("usda")
    expect(result?.match.provider).toBe("usda")
    expect(result?.match.providerId).toBe("999111")
    expect(result?.match.productName).toBe("Resolvertest Flour")
  })

  it("does not query OFF for a generic-route food (routing-aware, not a single fixed chain)", async () => {
    config.usda.apiKey = "test-key"
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(fdcResponse("Resolvertest Sugar", 999222))

    await resolveNutrients({ foodName: "Resolvertest Sugar", brand: null, category: null, state: "unknown" }, "generic")

    // Every fetched URL must be a USDA FDC URL, never an Open Food Facts one.
    for (const call of fetchMock.mock.calls) {
      expect(String(call[0])).toContain("api.nal.usda.gov")
      expect(String(call[0])).not.toContain("openfoodfacts")
    }
  })

  it("returns null when no provider resolves the query, rather than fabricating a match", async () => {
    config.usda.apiKey = "test-key"
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ foods: [] }), { status: 200 }))

    const result = await resolveNutrients({ foodName: "Resolvertestnonexistent", brand: null, category: null, state: "unknown" }, "generic")
    expect(result).toBeNull()
  })
})
