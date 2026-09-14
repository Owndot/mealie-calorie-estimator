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

  it("generic route starts with the local generic provider", () => {
    const chain = getProviderChain("generic")
    expect(chain[0].name).toBe("local-generic")
  })

  it("branded route starts with OFF, then falls back to the generic chain", () => {
    const chain = getProviderChain("branded")
    expect(chain[0].name).toBe("off")
    expect(chain.map((p) => p.name)).toContain("local-generic")
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
    expect(generic.map((p) => p.name)).toContain("usda")
  })

  it("never includes a BLS entry (not implemented pending licensing — no dummy placeholder either)", () => {
    const generic = getProviderChain("generic")
    const branded = getProviderChain("branded")
    expect(generic.map((p) => p.name)).not.toContain("bls")
    expect(branded.map((p) => p.name)).not.toContain("bls")
  })

  it("does not include the LLM provider when LLM is disabled", () => {
    config.llm.enabled = false
    expect(getProviderChain("generic").map((p) => p.name)).not.toContain("llm")
  })

  it("appends the LLM provider last on both routes when LLM is enabled and configured", () => {
    config.llm.enabled = true
    config.llm.apiKey = "test-key"
    const generic = getProviderChain("generic")
    const branded = getProviderChain("branded")
    expect(generic[generic.length - 1].name).toBe("llm")
    expect(branded[branded.length - 1].name).toBe("llm")
  })

  it("does not include the LLM provider when enabled but no API key is set", () => {
    config.llm.enabled = true
    config.llm.apiKey = ""
    expect(getProviderChain("generic").map((p) => p.name)).not.toContain("llm")
  })
})
