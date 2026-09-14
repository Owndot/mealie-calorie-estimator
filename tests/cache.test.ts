import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest"
import {
  initCache, flushCache, buildQueryKey,
  getCachedProviderMatch, setCachedProviderMatch,
  isProviderMiss, markProviderMiss,
  getCachedLlmEstimate, setCachedLlmEstimate,
  getCachedLlmNutrients, setCachedLlmNutrients,
  getCacheStats,
} from "../src/utils/cache.js"
import type { ProviderMatch } from "../src/types.js"
import { config } from "../src/config.js"
import fs from "node:fs"

const TEST_DB = "data/test-cache.db"

function clearDb(): void {
  if (fs.existsSync(TEST_DB)) {
    fs.unlinkSync(TEST_DB)
  }
}

function match(overrides: Partial<ProviderMatch> = {}): ProviderMatch {
  return {
    nutrients: {
      kcalPer100g: 364, proteinPer100g: 10, carbsPer100g: 76, fatPer100g: 1,
      saturatedFatPer100g: 0.2, transFatPer100g: 0, unsaturatedFatPer100g: 0.8,
      fiberPer100g: 2.7, sugarPer100g: 0.4, sodiumPer100g: 0.002, cholesterolPer100g: 0,
    },
    canonicalName: "Mehl",
    brand: null,
    state: "unknown",
    provider: "local-generic",
    providerId: "Mehl",
    productName: "Mehl",
    confidence: 0.7,
    ...overrides,
  }
}

describe("cache", () => {
  beforeAll(async () => {
    clearDb()
    await initCache()
  })

  afterAll(() => {
    clearDb()
  })

  describe("provider match cache", () => {
    it("stores and retrieves a provider match", () => {
      const key = buildQueryKey("flour", null)
      setCachedProviderMatch("local-generic", key, match())
      const cached = getCachedProviderMatch("local-generic", key)
      expect(cached?.nutrients.kcalPer100g).toBe(364)
      expect(cached?.canonicalName).toBe("Mehl")
    })

    it("is case-insensitive via buildQueryKey", () => {
      const key = buildQueryKey("FLOUR", null)
      setCachedProviderMatch("local-generic", key, match())
      expect(getCachedProviderMatch("local-generic", buildQueryKey("flour", null))?.nutrients.kcalPer100g).toBe(364)
    })

    it("returns undefined for uncached queries", () => {
      expect(getCachedProviderMatch("local-generic", buildQueryKey("nonexistent-food", null))).toBeUndefined()
    })

    it("does not poison cache between a generic and branded lookup of the same food name", () => {
      const genericKey = buildQueryKey("Joghurt", null)
      const brandedKey = buildQueryKey("Joghurt", "Danone")
      expect(genericKey).not.toBe(brandedKey)

      setCachedProviderMatch("local-generic", genericKey, match({ brand: null, confidence: 0.7 }))
      setCachedProviderMatch("off", brandedKey, match({ brand: "Danone", confidence: 0.9, provider: "off" }))

      expect(getCachedProviderMatch("local-generic", genericKey)?.brand).toBeNull()
      expect(getCachedProviderMatch("off", brandedKey)?.brand).toBe("Danone")
    })

    it("keeps different providers' cache entries for the same query key independent", () => {
      const key = buildQueryKey("Tomate", null)
      setCachedProviderMatch("local-generic", key, match({ provider: "local-generic", confidence: 0.7 }))
      setCachedProviderMatch("usda", key, match({ provider: "usda", confidence: 0.85 }))

      expect(getCachedProviderMatch("local-generic", key)?.confidence).toBe(0.7)
      expect(getCachedProviderMatch("usda", key)?.confidence).toBe(0.85)
    })
  })

  describe("provider miss cache", () => {
    it("tracks a known miss", () => {
      const key = buildQueryKey("unknown-spice", null)
      expect(isProviderMiss("off", key)).toBe(false)
      markProviderMiss("off", key)
      expect(isProviderMiss("off", key)).toBe(true)
    })

    it("keeps misses independent per provider", () => {
      const key = buildQueryKey("some-obscure-food", null)
      markProviderMiss("off", key)
      expect(isProviderMiss("off", key)).toBe(true)
      expect(isProviderMiss("usda", key)).toBe(false)
    })
  })

  describe("LLM caches", () => {
    beforeEach(() => {
      config.llm.enabled = true
      config.llm.apiKey = "test"
    })

    it("stores and retrieves an LLM gram estimate", () => {
      setCachedLlmEstimate("Dose", "Tomaten", 400)
      expect(getCachedLlmEstimate("Dose", "Tomaten")).toBe(400)
    })

    it("stores and retrieves LLM nutrient estimates", () => {
      setCachedLlmNutrients("obscure-food", match().nutrients)
      expect(getCachedLlmNutrients("obscure-food")?.kcalPer100g).toBe(364)
    })
  })

  it("reports cache stats", () => {
    setCachedProviderMatch("local-generic", buildQueryKey("stats-food", null), match())
    markProviderMiss("off", buildQueryKey("stats-miss", null))
    const stats = getCacheStats()
    expect(stats.providerMatches).toBeGreaterThan(0)
    expect(stats.providerMisses).toBeGreaterThan(0)
  })

  it("survives a flush + reload cycle (container restart)", async () => {
    const key = buildQueryKey("restart-test-food", null)
    setCachedProviderMatch("local-generic", key, match({ canonicalName: "RestartFood" }))
    flushCache()

    expect(fs.existsSync(TEST_DB)).toBe(true)
    const buffer = fs.readFileSync(TEST_DB)
    expect(buffer.length).toBeGreaterThan(0)

    // Prove real persistence, not just "a file got written": load the exported bytes into a
    // brand new sql.js Database (simulating a fresh process reading the file after a restart)
    // and query the row back directly, independent of the module's own in-memory db handle.
    const initSqlJs = (await import("sql.js")).default
    const SQL = await initSqlJs()
    const reloaded = new SQL.Database(buffer)
    const stmt = reloaded.prepare("SELECT canonical_name FROM provider_match_cache WHERE provider = ? AND query_key = ?")
    stmt.bind(["local-generic", key])
    expect(stmt.step()).toBe(true)
    expect((stmt.getAsObject() as { canonical_name: string }).canonical_name).toBe("RestartFood")
    stmt.free()
    reloaded.close()
  })

  it("a fresh module instance calling initCache() against the same file (a real process restart) reads back prior writes", async () => {
    const key = buildQueryKey("true-restart-food", null)
    setCachedProviderMatch("local-generic", key, match({ canonicalName: "TrueRestartFood" }))
    flushCache()

    vi.resetModules()
    const freshCacheModule = await import("../src/utils/cache.js")
    await freshCacheModule.initCache()

    const reloadedMatch = freshCacheModule.getCachedProviderMatch("local-generic", key)
    expect(reloadedMatch?.canonicalName).toBe("TrueRestartFood")
  })
})
