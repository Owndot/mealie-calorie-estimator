import { describe, it, expect, beforeEach } from "vitest"
import { getProviderChain } from "../../src/services/providers/registry.js"
import { config } from "../../src/config.js"

describe("getProviderChain — routing-aware, not a single global chain", () => {
  beforeEach(() => {
    config.usda.apiKey = ""
    config.llm.enabled = false
    config.llm.apiKey = ""
  })

  it("generic route never includes OFF", () => {
    const chain = getProviderChain("generic")
    expect(chain.map((p) => p.name)).not.toContain("off")
  })

  it("generic route is empty when nothing is configured — no hand-authored dataset fills the gap", () => {
    const chain = getProviderChain("generic")
    expect(chain).toEqual([])
  })

  it("branded route starts with OFF, then falls back to USDA when configured", () => {
    config.usda.apiKey = "some-key"
    const chain = getProviderChain("branded")
    expect(chain[0].name).toBe("off")
    expect(chain.map((p) => p.name)).toContain("usda")
  })

  it("branded route is just [off] when USDA is unconfigured — no filler provider", () => {
    config.usda.apiKey = ""
    const chain = getProviderChain("branded")
    expect(chain.map((p) => p.name)).toEqual(["off"])
  })

  it("does not include a USDA entry — dummy or real — when USDA_API_KEY is unset", () => {
    config.usda.apiKey = ""
    const generic = getProviderChain("generic")
    const branded = getProviderChain("branded")
    expect(generic.map((p) => p.name)).not.toContain("usda")
    expect(branded.map((p) => p.name)).not.toContain("usda")
  })

  it("includes a real USDA provider only once USDA_API_KEY is configured", () => {
    config.usda.apiKey = "some-key"
    const generic = getProviderChain("generic")
    expect(generic.map((p) => p.name)).toEqual(["usda"])
  })

  it("never includes a local hand-authored nutrition dataset (removed from the authoritative chain) or a BLS entry (not implemented pending licensing)", () => {
    config.usda.apiKey = "some-key"
    const generic = getProviderChain("generic")
    const branded = getProviderChain("branded")
    expect(generic.map((p) => p.name)).not.toContain("local-generic")
    expect(branded.map((p) => p.name)).not.toContain("local-generic")
    expect(generic.map((p) => p.name)).not.toContain("bls")
    expect(branded.map((p) => p.name)).not.toContain("bls")
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

  it("LLM is the ONLY provider on the generic route when USDA is unconfigured but LLM is enabled", () => {
    config.usda.apiKey = ""
    config.llm.enabled = true
    config.llm.apiKey = "test-key"
    expect(getProviderChain("generic").map((p) => p.name)).toEqual(["llm-nutrient"])
  })

  it("does not include the LLM provider when enabled but no API key is set", () => {
    config.llm.enabled = true
    config.llm.apiKey = ""
    expect(getProviderChain("generic").map((p) => p.name)).not.toContain("llm-nutrient")
  })
})
