import { describe, it, expect, beforeEach } from "vitest"
import { getProviderChain } from "../../src/services/providers/registry.js"
import { config } from "../../src/config.js"

describe("getProviderChain — routing-aware, not a single global chain", () => {
  beforeEach(() => {
    config.llm.enabled = false
    config.llm.apiKey = ""
  })

  it("generic route is BLS, then the local USDA database, then OFF", () => {
    // USDA precedes OFF here: it is a generic-food database answering a generic question, while
    // OFF is branded product-label data. Both are always present — USDA used to be conditional on
    // an API key, and there is no key any more.
    const chain = getProviderChain("generic").map((p) => p.name)
    expect(chain).toEqual(["mealie-recipe", "bls", "usda-local", "off"])
  })

  it("branded route starts with OFF, then BLS, then the local USDA database", () => {
    const chain = getProviderChain("branded")
    expect(chain.map((p) => p.name)).toEqual(["mealie-recipe", "off", "bls", "usda-local"])
  })

  it("never contains the removed live FoodData Central provider", () => {
    // The API path is gone, not disabled. A chain entry named "usda" would mean it came back.
    for (const route of ["generic", "branded"] as const) {
      expect(getProviderChain(route).map((p) => p.name)).not.toContain("usda")
    }
  })

  it("includes USDA unconditionally — it is a bundled file, not a keyed network service", () => {
    // The old chain silently lost USDA whenever USDA_API_KEY was unset, which is how a
    // misconfigured deployment quietly ran with one fewer database.
    for (const route of ["generic", "branded"] as const) {
      expect(getProviderChain(route).map((p) => p.name)).toContain("usda-local")
    }
  })

  it("never includes a local hand-authored nutrition dataset (BLS is real bundled data, not hand-authored)", () => {
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
    config.llm.enabled = true
    config.llm.apiKey = "test-key"
    const generic = getProviderChain("generic")
    const branded = getProviderChain("branded")
    expect(generic[generic.length - 1].name).toBe("llm-nutrient")
    expect(branded[branded.length - 1].name).toBe("llm-nutrient")
  })

  it("appends the LLM last on the generic route when it is enabled", () => {
    config.llm.enabled = true
    config.llm.apiKey = "test-key"
    expect(getProviderChain("generic").map((p) => p.name))
      .toEqual(["mealie-recipe", "bls", "usda-local", "off", "llm-nutrient"])
  })

  it("does not include the LLM provider when enabled but no API key is set", () => {
    config.llm.enabled = true
    config.llm.apiKey = ""
    expect(getProviderChain("generic").map((p) => p.name)).not.toContain("llm-nutrient")
  })
})
