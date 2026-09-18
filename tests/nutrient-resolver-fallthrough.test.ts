import { describe, it, expect, vi, beforeEach } from "vitest"
import type { NutrientSet } from "../src/types.js"
import { providerQuery } from "./helpers/provider-query.js"

const badNutrients: NutrientSet = {
  kcalPer100g: -10, proteinPer100g: null, carbsPer100g: null, fatPer100g: null,
  saturatedFatPer100g: null, transFatPer100g: null, unsaturatedFatPer100g: null,
  fiberPer100g: null, sugarPer100g: null, sodiumPer100g: null, cholesterolPer100g: null,
}

const goodNutrients: NutrientSet = {
  kcalPer100g: 50, proteinPer100g: 1, carbsPer100g: 10, fatPer100g: 0.2,
  saturatedFatPer100g: null, transFatPer100g: null, unsaturatedFatPer100g: null,
  fiberPer100g: null, sugarPer100g: null, sodiumPer100g: null, cholesterolPer100g: null,
}

vi.mock("../src/services/providers/registry.js", () => ({
  getProviderChain: () => [
    {
      name: "bad-provider",
      lookup: async () => ({
        nutrients: badNutrients, canonicalName: "x", brand: null, state: "unknown",
        provider: "bad-provider", providerId: null, productName: null, confidence: 0.9,
      }),
    },
    {
      name: "good-provider",
      lookup: async () => ({
        nutrients: goodNutrients, canonicalName: "x", brand: null, state: "unknown",
        provider: "good-provider", providerId: null, productName: null, confidence: 0.5,
      }),
    },
  ],
}))

describe("resolveNutrients — sanity-check rejection falls through to the next provider", () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it("rejects the first provider's implausible candidate and accepts the second's plausible one", async () => {
    const { resolveNutrients } = await import("../src/services/nutrient-resolver.js")
    const result = await resolveNutrients(providerQuery({ foodName: "x" }), "generic")
    expect(result?.match.provider).toBe("good-provider")
  })
})
