import { describe, it, expect, vi } from "vitest"
import type { NutrientSet } from "../../src/types.js"
import type { ProviderQuery } from "../../src/services/providers/types.js"

/**
 * Full-chain routing-order tests: proves the exact sequencing required by the architecture —
 *   generic:  cache -> BLS -> USDA local -> OFF -> LLM last
 *   branded:  cache -> OFF -> BLS -> USDA local -> LLM last
 * — and specifically that a provider earlier in the chain producing an acceptable match means
 * every later provider is never even called (no wasted network calls / rate-limit spend).
 */

function nutrients(overrides: Partial<NutrientSet> = {}): NutrientSet {
  return {
    kcalPer100g: 78, proteinPer100g: 5, carbsPer100g: 10, fatPer100g: 2,
    saturatedFatPer100g: 1, transFatPer100g: null, unsaturatedFatPer100g: 1,
    fiberPer100g: 2, sugarPer100g: 3, sodiumPer100g: 0.1, cholesterolPer100g: 0,
    ...overrides,
  }
}

function query(overrides: Partial<ProviderQuery> = {}): ProviderQuery {
  return { foodName: "Test", structuredName: "Test", brand: null, category: null, state: "unknown", ...overrides }
}

function fakeMatch(provider: string, overrides: Record<string, unknown> = {}) {
  return {
    nutrients: nutrients(),
    canonicalName: "Test",
    brand: null,
    state: "unknown" as const,
    provider,
    providerId: `${provider}-1`,
    productName: `${provider} product`,
    confidence: 0.8,
    ...overrides,
  }
}

/** Sets up fresh module mocks for all four providers, returning their lookup spies. */
async function setupChainMocks(opts: {
  bls?: ReturnType<typeof vi.fn>
  usda?: ReturnType<typeof vi.fn>
  off?: ReturnType<typeof vi.fn>
  llm?: ReturnType<typeof vi.fn>
  llmEnabled?: boolean
}) {
  vi.resetModules()

  const blsLookup = opts.bls ?? vi.fn().mockResolvedValue(null)
  const offLookup = opts.off ?? vi.fn().mockResolvedValue(null)
  const llmLookup = opts.llm ?? vi.fn().mockResolvedValue(null)

  vi.doMock("../../src/services/providers/bls-provider.js", () => ({
    createBlsProviderIfAvailable: () => ({ name: "bls", lookup: blsLookup }),
  }))
  vi.doMock("../../src/services/providers/off-provider.js", () => ({
    offProvider: { name: "off", lookup: offLookup },
  }))
  vi.doMock("../../src/services/providers/llm-nutrient-provider.js", () => ({
    llmNutrientProvider: { name: "llm-nutrient", lookup: llmLookup },
  }))

  // USDA is now an always-present bundled database rather than a keyed optional service, so
  // there is no "unconfigured" branch to model.
  const usdaLookup = opts.usda ?? vi.fn().mockResolvedValue(null)
  vi.doMock("../../src/services/providers/usda-local-provider.js", () => ({
    usdaLocalProvider: { name: "usda-local", lookup: usdaLookup },
  }))

  const { config } = await import("../../src/config.js")
  config.llm.enabled = opts.llmEnabled ?? false
  config.llm.apiKey = opts.llmEnabled ? "test-key" : ""

  const { resolveNutrients } = await import("../../src/services/nutrient-resolver.js")
  return { resolveNutrients, blsLookup, offLookup, llmLookup }
}

describe("generic route — exact provider sequencing", () => {
  it("BLS accepted -> OFF and USDA are never called", async () => {
    const blsLookup = vi.fn().mockResolvedValue(fakeMatch("bls"))
    const usdaLookup = vi.fn().mockResolvedValue(fakeMatch("usda-local"))
    const offLookup = vi.fn().mockResolvedValue(fakeMatch("off"))
    const { resolveNutrients } = await setupChainMocks({ bls: blsLookup, usda: usdaLookup, off: offLookup })

    const result = await resolveNutrients(query(), "generic")

    expect(result?.fallbackStatus).toBe("bls")
    expect(usdaLookup).not.toHaveBeenCalled()
    expect(offLookup).not.toHaveBeenCalled()
  })

  it("BLS miss -> USDA local accepted -> OFF and the LLM nutrient fallback are never called", async () => {
    const blsLookup = vi.fn().mockResolvedValue(null)
    const usdaLookup = vi.fn().mockResolvedValue(fakeMatch("usda-local"))
    const offLookup = vi.fn().mockResolvedValue(fakeMatch("off"))
    const llmLookup = vi.fn().mockResolvedValue(fakeMatch("llm-nutrient"))
    const { resolveNutrients } = await setupChainMocks({ bls: blsLookup, usda: usdaLookup, off: offLookup, llm: llmLookup, llmEnabled: true })

    const result = await resolveNutrients(query(), "generic")

    expect(result?.fallbackStatus).toBe("usda-local")
    expect(offLookup).not.toHaveBeenCalled()
    expect(llmLookup).not.toHaveBeenCalled()
  })

  it("BLS miss, USDA local miss -> OFF is tried and can be accepted", async () => {
    const blsLookup = vi.fn().mockResolvedValue(null)
    const usdaLookup = vi.fn().mockResolvedValue(null)
    const offLookup = vi.fn().mockResolvedValue(fakeMatch("off"))
    const llmLookup = vi.fn().mockResolvedValue(fakeMatch("llm-nutrient"))
    const { resolveNutrients } = await setupChainMocks({ bls: blsLookup, usda: usdaLookup, off: offLookup, llm: llmLookup, llmEnabled: true })

    const result = await resolveNutrients(query(), "generic")

    expect(result?.fallbackStatus).toBe("off")
    expect(usdaLookup).toHaveBeenCalledTimes(1)
    expect(offLookup).toHaveBeenCalledTimes(1)
    expect(llmLookup).not.toHaveBeenCalled()
  })

  it("BLS, USDA local and OFF all miss -> the LLM nutrient fallback runs as the absolute last resort", async () => {
    const blsLookup = vi.fn().mockResolvedValue(null)
    const usdaLookup = vi.fn().mockResolvedValue(null)
    const offLookup = vi.fn().mockResolvedValue(null)
    const llmLookup = vi.fn().mockResolvedValue(fakeMatch("llm-nutrient"))
    const { resolveNutrients } = await setupChainMocks({ bls: blsLookup, usda: usdaLookup, off: offLookup, llm: llmLookup, llmEnabled: true })

    const result = await resolveNutrients(query(), "generic")

    expect(result?.fallbackStatus).toBe("llm-nutrient")
    // The chain itself still runs each provider exactly once, in order. The two LOCAL databases
    // are then consulted a SECOND time, in the semantic judge's diagnostic pool pass: a provider's
    // negative cache short-circuits before anything is scored, so the gate survivors an
    // already-missed ingredient has are otherwise never computed. That pass consults no cache,
    // reranks nothing and issues no request.
    expect(blsLookup).toHaveBeenCalledTimes(2)
    expect(usdaLookup).toHaveBeenCalledTimes(2)
    // OFF is NOT re-queried — it is a rate-limited network provider, and the pool pass is
    // deliberately local-only.
    expect(offLookup).toHaveBeenCalledTimes(1)
    expect(llmLookup).toHaveBeenCalledTimes(1)
    expect(blsLookup.mock.calls[1][0]).toMatchObject({ poolOnly: true })
    expect(usdaLookup.mock.calls[1][0]).toMatchObject({ poolOnly: true })
  })

  it("BLS, OFF, USDA all miss and the LLM is disabled -> unresolved, nothing is fabricated", async () => {
    const { resolveNutrients } = await setupChainMocks({
      bls: vi.fn().mockResolvedValue(null),
      usda: vi.fn().mockResolvedValue(null),
      off: vi.fn().mockResolvedValue(null),
      llmEnabled: false,
    })

    const result = await resolveNutrients(query(), "generic")
    expect(result).toBeNull()
  })
})

describe("branded route — exact provider sequencing", () => {
  it("OFF accepted -> BLS, USDA, and the LLM nutrient fallback are never called", async () => {
    const blsLookup = vi.fn().mockResolvedValue(fakeMatch("bls"))
    const usdaLookup = vi.fn().mockResolvedValue(fakeMatch("usda-local"))
    const offLookup = vi.fn().mockResolvedValue(fakeMatch("off"))
    const llmLookup = vi.fn().mockResolvedValue(fakeMatch("llm-nutrient"))
    const { resolveNutrients } = await setupChainMocks({ bls: blsLookup, usda: usdaLookup, off: offLookup, llm: llmLookup, llmEnabled: true })

    const result = await resolveNutrients(query({ brand: "SomeBrand" }), "branded")

    expect(result?.fallbackStatus).toBe("off")
    expect(blsLookup).not.toHaveBeenCalled()
    expect(usdaLookup).not.toHaveBeenCalled()
    expect(llmLookup).not.toHaveBeenCalled()
  })

  it("OFF miss -> BLS -> USDA only if BLS also misses -> LLM only if all three fail", async () => {
    const blsLookup = vi.fn().mockResolvedValue(null)
    const usdaLookup = vi.fn().mockResolvedValue(fakeMatch("usda-local"))
    const offLookup = vi.fn().mockResolvedValue(null)
    const llmLookup = vi.fn().mockResolvedValue(fakeMatch("llm-nutrient"))
    const { resolveNutrients } = await setupChainMocks({ bls: blsLookup, usda: usdaLookup, off: offLookup, llm: llmLookup, llmEnabled: true })

    const result = await resolveNutrients(query({ brand: "SomeBrand" }), "branded")

    expect(offLookup).toHaveBeenCalledTimes(1)
    expect(blsLookup).toHaveBeenCalledTimes(1)
    expect(result?.fallbackStatus).toBe("usda-local")
    expect(llmLookup).not.toHaveBeenCalled()
  })

  it("OFF, BLS, and USDA all miss on the branded route -> the LLM nutrient fallback runs last", async () => {
    const { resolveNutrients, blsLookup, offLookup, llmLookup } = await setupChainMocks({
      bls: vi.fn().mockResolvedValue(null),
      usda: vi.fn().mockResolvedValue(null),
      off: vi.fn().mockResolvedValue(null),
      llm: vi.fn().mockResolvedValue(fakeMatch("llm-nutrient")),
      llmEnabled: true,
    })

    const result = await resolveNutrients(query({ brand: "SomeBrand" }), "branded")

    expect(result?.fallbackStatus).toBe("llm-nutrient")
    // Same contract on the branded route: the chain runs each provider once, then the local
    // databases are re-consulted for the judge's candidate pool. OFF is not.
    expect(blsLookup).toHaveBeenCalledTimes(2)
    expect(blsLookup.mock.calls[1][0]).toMatchObject({ poolOnly: true })
    expect(offLookup).toHaveBeenCalledTimes(1)
    expect(llmLookup).toHaveBeenCalledTimes(1)
  })
})
