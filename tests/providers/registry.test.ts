import { describe, it, expect, beforeEach } from "vitest"
import { getProviderChain } from "../../src/services/providers/registry.js"
import { config } from "../../src/config.js"

describe("getProviderChain — routing-aware, not a single global chain", () => {
  beforeEach(() => {
    config.usda.apiKey = ""
    config.llm.enabled = false
    config.llm.apiKey = ""
  })

  it("generic route is BLS, then OFF, then USDA last among structured databases", () => {
    // Explicit routing spec: generic = cache -> BLS -> OFF -> USDA -> LLM. OFF precedes USDA on
    // this route deliberately (not the other way round) — it is only skipped when BLS already
    // produced an acceptable match.
    config.usda.apiKey = "some-key"
    const chain = getProviderChain("generic").map((p) => p.name)
    expect(chain).toEqual(["mealie-recipe", "bls", "off", "usda"])
  })

  it("generic route is [bls, off] when USDA is unconfigured — BLS is bundled, OFF is the final DB fallback", () => {
    const chain = getProviderChain("generic")
    expect(chain.map((p) => p.name)).toEqual(["mealie-recipe", "bls", "off"])
  })

  it("branded route starts with OFF, then falls back to BLS, then USDA when configured", () => {
    config.usda.apiKey = "some-key"
    const chain = getProviderChain("branded")
    expect(chain.map((p) => p.name)).toEqual(["mealie-recipe", "off", "bls", "usda"])
  })

  it("branded route is [off, bls] when USDA is unconfigured — no filler provider for USDA specifically", () => {
    config.usda.apiKey = ""
    const chain = getProviderChain("branded")
    expect(chain.map((p) => p.name)).toEqual(["mealie-recipe", "off", "bls"])
  })

  it("does not include a USDA entry — dummy or real — when USDA_API_KEY is unset", () => {
    config.usda.apiKey = ""
    const generic = getProviderChain("generic")
    const branded = getProviderChain("branded")
    expect(generic.map((p) => p.name)).not.toContain("usda")
    expect(branded.map((p) => p.name)).not.toContain("usda")
  })

  it("includes a real USDA provider, after BLS and OFF, only once USDA_API_KEY is configured", () => {
    config.usda.apiKey = "some-key"
    const generic = getProviderChain("generic")
    expect(generic.map((p) => p.name)).toEqual(["mealie-recipe", "bls", "off", "usda"])
  })

  it("never includes a local hand-authored nutrition dataset (BLS is real bundled data, not hand-authored)", () => {
    config.usda.apiKey = "some-key"
    const generic = getProviderChain("generic")
    const branded = getProviderChain("branded")
    expect(generic.map((p) => p.name)).not.toContain("local-generic")
    expect(branded.map((p) => p.name)).not.toContain("local-generic")
  })

  it("BLS is always present on both routes, independent of USDA configuration", () => {
    const generic = getProviderChain("generic")
    const branded = getProviderChain("branded")
    expect(generic.map((p) => p.name)).toContain("bls")
    expect(branded.map((p) => p.name)).toContain("bls")
  })

  it("does not include the LLM provider when LLM is disabled", () => {
    config.llm.enabled = false
    expect(getProviderChain("generic").map((p) => p.name)).not.toContain("llm-nutrient")
  })

  it("appends the LLM provider last on both routes when LLM is enabled and configured", () => {
    config.usda.apiKey = "some-key"
    config.llm.enabled = true
    config.llm.apiKey = "test-key"
    const generic = getProviderChain("generic")
    const branded = getProviderChain("branded")
    expect(generic[generic.length - 1].name).toBe("llm-nutrient")
    expect(branded[branded.length - 1].name).toBe("llm-nutrient")
  })

  it("BLS, then OFF, then LLM on the generic route when USDA is unconfigured but LLM is enabled", () => {
    config.usda.apiKey = ""
    config.llm.enabled = true
    config.llm.apiKey = "test-key"
    expect(getProviderChain("generic").map((p) => p.name)).toEqual(["mealie-recipe", "bls", "off", "llm-nutrient"])
  })

  it("does not include the LLM provider when enabled but no API key is set", () => {
    config.llm.enabled = true
    config.llm.apiKey = ""
    expect(getProviderChain("generic").map((p) => p.name)).not.toContain("llm-nutrient")
  })
})
