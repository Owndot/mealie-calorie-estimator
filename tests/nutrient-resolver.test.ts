import { describe, it, expect, beforeEach } from "vitest"
import { resolveNutrients } from "../src/services/nutrient-resolver.js"
import { config } from "../src/config.js"

beforeEach(() => {
  config.usda.apiKey = ""
  config.llm.enabled = false
  config.llm.apiKey = ""
})

describe("resolveNutrients", () => {
  it("resolves a real generic food via the local-generic provider on the generic route", async () => {
    const result = await resolveNutrients({ foodName: "Mehl", brand: null, category: null, state: "unknown" }, "generic")
    expect(result?.match.provider).toBe("local-generic")
    expect(result?.fallbackStatus).toBe("local-generic")
  })

  it("returns null when no provider in the chain can resolve the query", async () => {
    const result = await resolveNutrients(
      { foodName: "totally-unrecognizable-nonsense-food-xyz", brand: null, category: null, state: "unknown" },
      "generic",
    )
    expect(result).toBeNull()
  })

  it("does not query OFF for a generic-route food (routing-aware, not a single fixed chain)", async () => {
    // If OFF were queried, this would attempt a real network call in the test environment and
    // either throw or hang; local-generic resolving it directly proves OFF was never reached.
    const result = await resolveNutrients({ foodName: "Zucker", brand: null, category: null, state: "unknown" }, "generic")
    expect(result?.fallbackStatus).not.toBe("off")
  })
})
