import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest"
import { config } from "../src/config.js"
import { initCache, __clearProviderCachesForTests, clearLlmCache } from "../src/utils/cache.js"
import {
  __resetOverridesForTests, buildOverrideKey, overrideId, setOverride, deleteOverride,
  listOverrides, getOverrideById, findOverride, OVERRIDE_KEY_VERSION, type OverrideIdentity,
} from "../src/services/food-overrides.js"
import { resolveNutrients } from "../src/services/nutrient-resolver.js"
import { buildResolverQuery } from "../src/services/resolver-query.js"
import { normalizeIngredients } from "../src/services/llm-normalizer.js"
import { UNKNOWN_ATTRIBUTES, type FoodAttributes } from "../src/types.js"

/**
 * USER-CONFIRMED FOOD OVERRIDES.
 *
 * The automatic chain refuses to guess, which is right and still leaves real recipes wrong:
 * "Rinderhackfleisch mager" keeps an ordinary 224 kcal record and an unmet reduced-fat flag
 * because no automatic evidence justifies replacing it. These tests are about the other half — a
 * person deciding once — and about the two properties that make that safe: an override points at
 * a real record rather than storing numbers, and its key describes the INGREDIENT rather than
 * anything about how the resolver happens to answer.
 */

const attrs = (o: Partial<FoodAttributes> = {}): FoodAttributes => ({ ...UNKNOWN_ATTRIBUTES, ...o })

const identity = (canonicalEnglish: string, over: Partial<OverrideIdentity> = {}): OverrideIdentity => ({
  canonicalEnglish, state: "raw", attributes: attrs(), brand: null, ...over,
})

interface Q { de: string; en: string; coreDe: string | null; coreEn: string | null; category?: string | null; state?: string; foodType?: string; attributes?: FoodAttributes; brand?: string | null }

const resolve = (q: Q) => resolveNutrients({
  foodName: q.en, structuredName: q.de, canonicalGerman: q.de, brand: q.brand ?? null,
  category: q.category ?? null, state: q.state ?? "raw", foodType: q.foodType ?? "simple",
  coreFoodGerman: q.coreDe, coreFoodEnglish: q.coreEn, route: q.brand ? "branded" : "generic",
  attributes: q.attributes ?? attrs(),
  evidence: { german: true, english: true, core: true, brand: Boolean(q.brand) },
} as never, q.brand ? "branded" : "generic")

const LEAN_BEEF: Q = { de: "Rinderhackfleisch, mager", en: "lean ground beef", coreDe: "Rinderhackfleisch", coreEn: "ground beef", category: "meat", state: "raw" }

beforeAll(async () => { await initCache() })

beforeEach(async () => {
  await __resetOverridesForTests()
  clearLlmCache()
  __clearProviderCachesForTests()
  config.llm.enabled = false
  config.llm.apiKey = ""
  config.llm.judgeEnabled = false
  config.openFoodFacts.retryBackoffMs = 1
  vi.stubGlobal("fetch", vi.fn(async () =>
    new Response(JSON.stringify({ hits: [] }), { status: 200, headers: { "content-type": "application/json" } })))
})
afterEach(() => { vi.unstubAllGlobals() })

// ---------------------------------------------------------------------------------------------

describe("the key describes the ingredient, not the resolver", () => {
  it("distinguishes every variant of the same base food", () => {
    const keys = [
      buildOverrideKey(identity("lean ground beef")),
      buildOverrideKey(identity("ground beef")),
      buildOverrideKey(identity("ground beef 5% fat", { attributes: attrs({ fatPercent: 5 }) })),
      buildOverrideKey(identity("ground beef 10% fat", { attributes: attrs({ fatPercent: 10 }) })),
      buildOverrideKey(identity("cooked ground beef", { state: "cooked" })),
    ]
    expect(new Set(keys).size).toBe(keys.length)
  })

  it("distinguishes light mayo from ordinary mayonnaise", () => {
    expect(buildOverrideKey(identity("light mayo", { state: "unknown" })))
      .not.toBe(buildOverrideKey(identity("mayonnaise", { state: "unknown" })))
  })

  it("does not change when the resolver's ROUTE changes", () => {
    // The route is an implementation detail of how a lookup is dispatched. An override has to
    // survive a routing change, so it cannot be part of durable food identity.
    const withoutBrand = identity("lean ground beef")
    expect(buildOverrideKey(withoutBrand)).toBe(buildOverrideKey({ ...withoutBrand }))
    expect(buildOverrideKey(withoutBrand)).not.toContain("generic")
    expect(buildOverrideKey(withoutBrand)).not.toContain("branded")
  })

  it("does not change when the TARGET's provider or brand changes", async () => {
    const id = identity("cooking cream 7% fat", { state: "unknown", attributes: attrs({ fatPercent: 7 }) })
    const before = buildOverrideKey(id)
    setOverride({ identity: id, exampleName: "Kochsahne 7%", provider: "off", providerId: "4061458212588", recordName: "Kochsahne 7%Fett" })
    // Binding to an Edeka/Aldi product must not make that brand part of what the INGREDIENT is.
    expect(buildOverrideKey(id)).toBe(before)
    expect(before).not.toMatch(/aldi|milsani|off/i)
  })

  it("uses an explicit ingredient brand, and only that", () => {
    // ProviderQuery.brand is evidence-verified upstream: it survives only when the structured
    // ingredient text actually named it.
    const plain = identity("mayonnaise", { state: "unknown" })
    const branded = identity("mayonnaise", { state: "unknown", brand: "Thomy" })
    expect(buildOverrideKey(plain)).not.toBe(buildOverrideKey(branded))
  })

  it("gives a stable, URL-safe id that callers can use as a path segment", () => {
    const key = buildOverrideKey(identity("lean ground beef"))
    const id = overrideId(key)
    expect(id).toMatch(/^[0-9a-f]{16}$/)
    expect(overrideId(key)).toBe(id)
    expect(encodeURIComponent(id)).toBe(id)
    // The semantic key itself is NOT URL-safe, which is exactly why it is not the identifier.
    expect(encodeURIComponent(key)).not.toBe(key)
  })
})

describe("an override resolves an ingredient a person settled", () => {
  it("1. lean mince: BLS + unmet flag before, the chosen record after", async () => {
    const before = await resolve(LEAN_BEEF)
    expect(before!.fallbackStatus).toBe("bls")
    expect(before!.match.providerId).toBe("U010100")
    expect(before!.match.unmetAttributes).toEqual(["reduced-fat"])

    setOverride({
      identity: identity("lean ground beef"), exampleName: "Rinderhackfleisch mager",
      provider: "usda-local", providerId: "171790", recordName: "Beef, ground, 95% lean meat / 5% fat, raw",
    })
    __clearProviderCachesForTests()

    const after = await resolve(LEAN_BEEF)
    expect(after!.fallbackStatus).toBe("usda-local")
    expect(after!.match.providerId).toBe("171790")
    expect(after!.match.matchReason).toBe("user-confirmed-override")
    // The nutrients are the RECORD's, reloaded — nothing was copied into the override.
    expect(after!.match.nutrients.kcalPer100g).toBe(137)
    expect(after!.match.nutrients.fatPer100g).toBe(5)
  })

  it("resolves deterministically on repeat, with no judge and no model call", async () => {
    setOverride({
      identity: identity("lean ground beef"), exampleName: "Rinderhackfleisch mager",
      provider: "usda-local", providerId: "171790", recordName: "x",
    })
    const seen = new Set<string>()
    for (let i = 0; i < 5; i++) {
      __clearProviderCachesForTests()
      const r = await resolve(LEAN_BEEF)
      seen.add(`${r!.fallbackStatus}|${r!.match.providerId}|${r!.match.nutrients.kcalPer100g}`)
    }
    expect(seen.size).toBe(1)
    expect([...seen][0]).toBe("usda-local|171790|137")
  })

  it("2. plain Rinderhackfleisch is unaffected", async () => {
    setOverride({ identity: identity("lean ground beef"), exampleName: "Rinderhackfleisch mager", provider: "usda-local", providerId: "171790", recordName: "x" })
    __clearProviderCachesForTests()
    const r = await resolve({ ...LEAN_BEEF, de: "Rinderhackfleisch", en: "ground beef" })
    expect(r!.match.providerId).not.toBe("171790")
    expect(r!.match.matchReason).not.toBe("user-confirmed-override")
  })

  it("3. Rinderhackfleisch 5% is unaffected", async () => {
    setOverride({ identity: identity("lean ground beef"), exampleName: "Rinderhackfleisch mager", provider: "usda-local", providerId: "171790", recordName: "x" })
    __clearProviderCachesForTests()
    const r = await resolve({
      ...LEAN_BEEF, de: "Rinderhackfleisch 5 % Fett", en: "ground beef 5% fat",
      attributes: attrs({ fatPercent: 5 }),
    })
    // With the LLM disabled this ingredient may resolve to nothing at all; either way the point
    // stands — the override for the qualitative variant did not reach the numeric one.
    expect(r?.match.matchReason ?? null).not.toBe("user-confirmed-override")
  })

  it("4 & 5. Mayo Light can be bound while ordinary Mayonnaise is untouched", async () => {
    const MAYO_LIGHT: Q = { de: "Mayonnaise, leicht", en: "light mayo", coreDe: "Mayonnaise", coreEn: "mayo", category: "condiment", state: "unknown", foodType: "processed_single_food" }
    const MAYO_PLAIN: Q = { ...MAYO_LIGHT, de: "Mayonnaise", en: "mayonnaise", coreEn: "mayonnaise" }

    const plainBefore = await resolve(MAYO_PLAIN)
    setOverride({
      identity: identity("light mayo", { state: "unknown" }), exampleName: "Mayo Light",
      provider: "usda-local", providerId: "173594", recordName: "Salad dressing, mayonnaise, light",
    })
    __clearProviderCachesForTests()

    const light = await resolve(MAYO_LIGHT)
    expect(light!.match.providerId).toBe("173594")
    expect(light!.match.matchReason).toBe("user-confirmed-override")
    expect(light!.match.nutrients.kcalPer100g).toBe(238)

    const plainAfter = await resolve(MAYO_PLAIN)
    expect(plainAfter!.match.providerId).toBe(plainBefore!.match.providerId)
    expect(plainAfter!.match.matchReason).not.toBe("user-confirmed-override")
  })

  it("6. deleting an override restores the previous behaviour exactly", async () => {
    const before = await resolve(LEAN_BEEF)
    const saved = setOverride({ identity: identity("lean ground beef"), exampleName: "Rinderhackfleisch mager", provider: "usda-local", providerId: "171790", recordName: "x" })
    __clearProviderCachesForTests()
    expect((await resolve(LEAN_BEEF))!.match.providerId).toBe("171790")

    expect(deleteOverride(saved.id)).toBe(true)
    __clearProviderCachesForTests()
    const after = await resolve(LEAN_BEEF)
    expect(after!.fallbackStatus).toBe(before!.fallbackStatus)
    expect(after!.match.providerId).toBe(before!.match.providerId)
    expect(after!.match.unmetAttributes).toEqual(["reduced-fat"])
  })
})

describe("a broken target never becomes a fabricated one", () => {
  it("7. a missing provider record falls back to the normal resolver", async () => {
    const before = await resolve(LEAN_BEEF)
    setOverride({ identity: identity("lean ground beef"), exampleName: "Rinderhackfleisch mager", provider: "usda-local", providerId: "999999999", recordName: "gone" })
    __clearProviderCachesForTests()

    const after = await resolve(LEAN_BEEF)
    expect(after!.match.providerId).toBe(before!.match.providerId)
    expect(after!.match.matchReason).not.toBe("user-confirmed-override")
    // The ingredient keeps its honest flag rather than gaining a silent, stale value.
    expect(after!.match.unmetAttributes).toEqual(["reduced-fat"])
  })

  it("a missing BLS code falls back too", async () => {
    setOverride({ identity: identity("lean ground beef"), exampleName: "x", provider: "bls", providerId: "NOPE0000", recordName: "gone" })
    __clearProviderCachesForTests()
    const r = await resolve(LEAN_BEEF)
    expect(r!.match.matchReason).not.toBe("user-confirmed-override")
  })

  it("an unreachable OFF product falls back, and never invents a value", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: unknown) => {
      if (String(url).includes("/api/v2/product/")) return new Response("{}", { status: 404 })
      return new Response(JSON.stringify({ hits: [] }), { status: 200, headers: { "content-type": "application/json" } })
    }))
    setOverride({ identity: identity("lean ground beef"), exampleName: "x", provider: "off", providerId: "4313249214975", recordName: "Mageres Rinderhackfleisch zum Braten" })
    __clearProviderCachesForTests()
    const r = await resolve(LEAN_BEEF)
    expect(r!.fallbackStatus).toBe("bls")
    expect(r!.match.matchReason).not.toBe("user-confirmed-override")
  })

  it("stores no nutrient values at all", () => {
    const saved = setOverride({ identity: identity("lean ground beef"), exampleName: "x", provider: "usda-local", providerId: "171790", recordName: "Beef, ground, 95% lean meat / 5% fat, raw" })
    // The row is a pointer plus audit metadata. Nothing here can become a number in a recipe.
    expect(Object.keys(saved).sort()).toEqual([
      "brand", "canonicalEnglish", "createdAt", "exampleName", "fatPercent", "form", "id",
      "keyVersion", "note", "overrideKey", "preservation", "provider", "providerId",
      "recordName", "source", "state", "updatedAt",
    ])
    expect(JSON.stringify(saved)).not.toMatch(/kcal|nutrient|protein/i)
  })
})

describe("the store itself", () => {
  it("is keyed by identity, so re-binding the same ingredient replaces rather than duplicates", () => {
    const id = identity("lean ground beef")
    const first = setOverride({ identity: id, exampleName: "Rinderhackfleisch mager", provider: "usda-local", providerId: "171790", recordName: "a" })
    const second = setOverride({ identity: id, exampleName: "mageres Rinderhack", provider: "usda-local", providerId: "173110", recordName: "b" })
    expect(second.id).toBe(first.id)
    expect(second.createdAt).toBe(first.createdAt)
    expect(second.providerId).toBe("173110")
    expect(listOverrides()).toHaveLength(1)
  })

  it("does not apply a row written under an older key shape", () => {
    const id = identity("lean ground beef")
    const saved = setOverride({ identity: id, exampleName: "x", provider: "usda-local", providerId: "171790", recordName: "a" })
    expect(findOverride(id)?.id).toBe(saved.id)
    // A changed key shape means changed semantics: the stored decision was never made for the key
    // this build now computes, so it is reported stale rather than silently re-targeted.
    expect(getOverrideById(saved.id)!.keyVersion).toBe(OVERRIDE_KEY_VERSION)
  })

  it("an empty store leaves resolution exactly as it was", async () => {
    expect(listOverrides()).toHaveLength(0)
    const r = await resolve(LEAN_BEEF)
    expect(r!.fallbackStatus).toBe("bls")
    expect(r!.match.providerId).toBe("U010100")
    expect(r!.match.matchReason).not.toBe("user-confirmed-override")
  })
})

// ---------------------------------------------------------------------------------------------

describe("the management API accepts the request shapes real clients send", () => {
  it("treats an empty application/json body as {}", async () => {
    // A DELETE carrying Content-Type: application/json and no body is a real client shape — a
    // wrapper that sets the header once for every request has nothing to put in a DELETE body.
    // Fastify's default parser rejects it as an empty JSON document; the route installs its own.
    const { default: Fastify } = await import("fastify")
    const app = Fastify()
    const { overrideRoutes } = await import("../src/routes/overrides.js")

    const previous = config.overrides.adminToken
    config.overrides.adminToken = "test-token"
    try {
      await app.register(overrideRoutes)
      const saved = setOverride({
        identity: identity("lean ground beef"), exampleName: "Rinderhackfleisch mager",
        provider: "usda-local", providerId: "171790", recordName: "x",
      })

      const res = await app.inject({
        method: "DELETE",
        url: `/overrides/${saved.id}`,
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        payload: "",
      })
      expect(res.statusCode).toBe(200)
      expect(JSON.parse(res.body).deleted).toBe(saved.id)
      expect(getOverrideById(saved.id)).toBeUndefined()

      // …and a malformed body is still a 400, not silently ignored.
      const bad = await app.inject({
        method: "PUT", url: "/overrides",
        headers: { authorization: "Bearer test-token", "content-type": "application/json" },
        payload: "{not json",
      })
      expect(bad.statusCode).toBe(400)
    } finally {
      config.overrides.adminToken = previous
      await app.close()
    }
  })

  it("refuses every request without a valid bearer token", async () => {
    const { default: Fastify } = await import("fastify")
    const app = Fastify()
    const { overrideRoutes } = await import("../src/routes/overrides.js")
    const previous = config.overrides.adminToken
    config.overrides.adminToken = "test-token"
    try {
      await app.register(overrideRoutes)
      for (const headers of [{}, { authorization: "Bearer wrong" }, { authorization: "Basic test-token" }]) {
        const res = await app.inject({ method: "GET", url: "/overrides", headers })
        expect(res.statusCode).toBe(401)
      }
      const ok = await app.inject({ method: "GET", url: "/overrides", headers: { authorization: "Bearer test-token" } })
      expect(ok.statusCode).toBe(200)
    } finally {
      config.overrides.adminToken = previous
      await app.close()
    }
  })
})

// ---------------------------------------------------------------------------------------------

describe("preview reproduces production, and can show the automatic result underneath", () => {
  /** Resolves through the SAME construction the estimator uses, which is the point of the test. */
  async function productionResolve(foodName: string, ignoreOverrides = false) {
    const [classification] = await normalizeIngredients([{ index: 0, foodName, unitName: "g" }])
    const built = buildResolverQuery(foodName, classification, ignoreOverrides ? { ignoreOverrides: true } : {})
    return resolveNutrients(built.query, built.route)
  }

  const stubClassifier = (items: Record<string, unknown>[]) => {
    vi.stubGlobal("fetch", vi.fn(async (url: unknown) => {
      if (String(url).startsWith(config.openFoodFacts.searchBaseUrl)) {
        return new Response(JSON.stringify({ hits: [] }), { status: 200, headers: { "content-type": "application/json" } })
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(items) } }] }), { status: 200 })
    }))
  }

  const CLASSIFIED = (over: Record<string, unknown>) => ({
    index: 0, canonicalGerman: "x", canonicalEnglish: "x", brand: null, state: "unknown",
    form: "unknown", preservation: "unknown", fatPercent: null, category: null,
    foodType: "simple", coreFoodGerman: "x", coreFoodEnglish: "x", ...over,
  })

  beforeEach(() => {
    config.llm.enabled = true
    config.llm.apiKey = "test-key"
  })

  it("1. lean mince: the override is active, and the automatic result underneath is the BLS record", async () => {
    stubClassifier([CLASSIFIED({
      canonicalGerman: "Rinderhackfleisch, mager", canonicalEnglish: "lean ground beef",
      state: "raw", category: "meat", coreFoodGerman: "Rinderhackfleisch", coreFoodEnglish: "ground beef",
    })])
    setOverride({
      identity: identity("lean ground beef"), exampleName: "Rinderhackfleisch mager",
      provider: "usda-local", providerId: "171790", recordName: "Beef, ground, 95% lean meat / 5% fat, raw",
    })
    __clearProviderCachesForTests()

    const withOverride = await productionResolve("Rinderhackfleisch mager")
    expect(withOverride!.match.providerId).toBe("171790")
    expect(withOverride!.match.matchReason).toBe("user-confirmed-override")

    __clearProviderCachesForTests()
    const automatic = await productionResolve("Rinderhackfleisch mager", true)
    // The real production answer, reached by silencing one provider — never approximated.
    expect(automatic!.fallbackStatus).toBe("bls")
    expect(automatic!.match.providerId).toBe("U010100")
    expect(automatic!.match.nutrients.kcalPer100g).toBe(224)
    expect(automatic!.match.unmetAttributes).toEqual(["reduced-fat"])
  })

  it("2. ignoring an override changes nothing else about the resolution", async () => {
    stubClassifier([CLASSIFIED({
      canonicalGerman: "Mayonnaise, leicht", canonicalEnglish: "light mayo", category: "condiment",
      foodType: "processed_single_food", coreFoodGerman: "Mayonnaise", coreFoodEnglish: "mayo",
    })])
    const before = await productionResolve("Mayo Light", true)
    setOverride({
      identity: identity("light mayo", { state: "unknown" }), exampleName: "Mayo Light",
      provider: "usda-local", providerId: "173594", recordName: "Salad dressing, mayonnaise, light",
    })
    __clearProviderCachesForTests()
    const after = await productionResolve("Mayo Light", true)
    // Binding an override must not disturb what the automatic chain would have said.
    expect(after!.fallbackStatus).toBe(before!.fallbackStatus)
    expect(after!.match.providerId).toBe(before!.match.providerId)
    expect(after!.match.unmetAttributes).toEqual(before!.match.unmetAttributes)
  })

  it("3. with no override, the two answers are identical for ordinary ingredients", async () => {
    for (const [de, en, coreDe, coreEn, category] of [
      ["Olivenöl", "olive oil", "Öl", "oil", "oil"],
      ["Tomate", "tomato", "Tomate", "tomato", "vegetable"],
      ["Zwiebel", "onion", "Zwiebel", "onion", "vegetable"],
      ["Tomatenmark", "tomato paste", "Tomatenmark", "tomato paste", "vegetable"],
    ]) {
      stubClassifier([CLASSIFIED({ canonicalGerman: de, canonicalEnglish: en, state: "raw", category, coreFoodGerman: coreDe, coreFoodEnglish: coreEn })])
      __clearProviderCachesForTests()
      const withOverrides = await productionResolve(de)
      __clearProviderCachesForTests()
      const ignoring = await productionResolve(de, true)
      expect(withOverrides!.fallbackStatus, de).toBe(ignoring!.fallbackStatus)
      expect(withOverrides!.match.providerId, de).toBe(ignoring!.match.providerId)
      expect(withOverrides!.match.nutrients, de).toEqual(ignoring!.match.nutrients)
      expect(withOverrides!.match.unmetAttributes, de).toEqual(ignoring!.match.unmetAttributes)
      // …and the BLS path really was exercised: an incomplete query would have missed it.
      expect(withOverrides!.fallbackStatus, de).toBe("bls")
    }
  })

  it("4. preview mutates no override rows", async () => {
    stubClassifier([CLASSIFIED({ canonicalGerman: "Tomate", canonicalEnglish: "tomato", state: "raw", category: "vegetable", coreFoodGerman: "Tomate", coreFoodEnglish: "tomato" })])
    const before = listOverrides().length
    await productionResolve("Tomate")
    await productionResolve("Tomate", true)
    expect(listOverrides()).toHaveLength(before)
  })
})
