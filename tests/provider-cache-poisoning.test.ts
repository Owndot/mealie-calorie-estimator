import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest"
import { config } from "../src/config.js"
import type { ProviderMatch, MealieRecipe, MealieIngredient, MealieRecipePatch } from "../src/types.js"

/**
 * The gap that let v1.0.2 ship a correct fix that did nothing in production.
 *
 * v1.0.1 selected Obstbrand/Obstwasser (P752100, 274 kcal, a fruit schnapps) for "Wasser" and
 * WROTE IT TO THE PERSISTENT CACHE before the resolver ever sanity-checked it. v1.0.2 fixed the
 * selection — and still returned the schnapps on every existing installation, because the cache is
 * consulted at the top of lookup(), before any scoring. The fix was never reached.
 *
 * Every v1.0.2 test started from an empty cache, so all 879 of them passed while the shipped image
 * failed. These tests start from a POISONED one, which is what a real upgrade looks like.
 */

const cacheWrites: { provider: string; key: string; match: ProviderMatch }[] = []

vi.mock("../src/utils/cache.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/utils/cache.js")>()
  return {
    ...actual,
    setCachedProviderMatch: vi.fn((provider: string, key: string, match: ProviderMatch) => {
      cacheWrites.push({ provider, key, match })
      return actual.setCachedProviderMatch(provider, key, match)
    }),
  }
})

vi.mock("../src/services/mealie-client.js", () => ({
  getRecipe: vi.fn(),
  getRecipeHouseholdId: vi.fn(() => null),
  listRecipeNames: vi.fn(async () => []),
  patchRecipe: vi.fn(async (slug: string, patch: MealieRecipePatch) => {
    patchCalls.push({ slug, patch })
  }),
  getOrCreateTags: vi.fn(async (names: string[]) =>
    names.map((name) => ({ id: name, name, slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), groupId: null })),
  ),
}))

const patchCalls: { slug: string; patch: MealieRecipePatch }[] = []

/** Exactly what v1.0.1 wrote to the cache for "Wasser". */
const SCHNAPPS: ProviderMatch = {
  nutrients: {
    kcalPer100g: 274, proteinPer100g: 0, carbsPer100g: 0, fatPer100g: 0,
    saturatedFatPer100g: null, transFatPer100g: null, unsaturatedFatPer100g: null,
    fiberPer100g: null, sugarPer100g: null, sodiumPer100g: null, cholesterolPer100g: null,
  },
  canonicalName: "Wasser",
  brand: null,
  state: "unknown",
  provider: "bls",
  providerId: "P752100",
  productName: "Obstbrand/Obstwasser",
  confidence: 0.57,
  dataType: null,
  foodType: "simple",
  matchReason: "fuzzy",
}

function ing(quantity: number, unitName: string, foodName: string): MealieIngredient {
  return {
    quantity,
    unit: { id: unitName, name: unitName, pluralName: unitName, abbreviation: null, standardQuantity: null, standardUnit: null },
    food: { id: foodName, name: foodName, pluralName: null, aliases: [] },
    note: null,
    display: `${quantity} ${unitName} ${foodName}`,
    title: null,
    originalText: `${quantity} ${unitName} ${foodName}`,
  }
}

function recipe(slug: string, servings: number, ingredients: MealieIngredient[]): MealieRecipe {
  return {
    slug, name: slug, recipeYield: `${servings} Portionen`, recipeServings: servings,
    recipeIngredient: ingredients, nutrition: null, tags: [], extras: {}, householdId: null,
  }
}

beforeAll(async () => {
  const { initCache } = await import("../src/utils/cache.js")
  await initCache()
})

beforeEach(() => {
  cacheWrites.length = 0
  patchCalls.length = 0
  config.llm.enabled = false
  config.llm.apiKey = ""
  config.llm.judgeEnabled = false
})

/**
 * Poisons the cache exactly the way v1.0.1 did: under the key the provider itself computes.
 * The key is captured from a real write rather than reconstructed, so this test cannot drift
 * out of step with BLS_MATCH_ALGORITHM_VERSION or the key format.
 */
const keyCache = new Map<string, string>()

async function poisonCacheFor(foodName: string): Promise<string> {
  const { createBlsProviderIfAvailable } = await import("../src/services/providers/bls-provider.js")
  const { buildResolverQuery } = await import("../src/services/resolver-query.js")
  const cache = await import("../src/utils/cache.js")

  let key = keyCache.get(foodName)
  if (!key) {
    // Learn the key the provider itself computes, from a real write. Captured rather than
    // reconstructed, so this cannot drift out of step with BLS_MATCH_ALGORITHM_VERSION or the
    // key format — the exact two things that made the production failure invisible to CI.
    cacheWrites.length = 0
    const { query } = buildResolverQuery(foodName, undefined, {})
    await createBlsProviderIfAvailable().lookup(query)
    const write = cacheWrites.find((w) => w.provider === "bls")
    expect(write, "the provider must have cached something to poison").toBeTruthy()
    key = write!.key
    keyCache.set(foodName, key)
  }

  cache.setCachedProviderMatch("bls", key, { ...SCHNAPPS, canonicalName: foodName })
  expect(cache.getCachedProviderMatch("bls", key)?.providerId).toBe("P752100")
  return key
}

describe("a poisoned provider cache cannot outlive the fix that corrects it", () => {
  it("a cached record that cannot be true for the query is re-scored, not replayed", async () => {
    const key = await poisonCacheFor("Wasser")

    const { createBlsProviderIfAvailable } = await import("../src/services/providers/bls-provider.js")
    const { buildResolverQuery } = await import("../src/services/resolver-query.js")
    const { query } = buildResolverQuery("Wasser", undefined, {})

    const match = await createBlsProviderIfAvailable().lookup(query)

    expect(match).not.toBeNull()
    expect(match!.providerId).toBe("N110000")
    expect(match!.productName).toBe("Trinkwasser")
    expect(match!.nutrients.kcalPer100g).toBe(0)
    expect(key).toBeTruthy()
  })

  it("re-scoring repairs the cache, so the correct answer is what persists", async () => {
    await poisonCacheFor("Wasser")

    const { createBlsProviderIfAvailable } = await import("../src/services/providers/bls-provider.js")
    const { buildResolverQuery } = await import("../src/services/resolver-query.js")
    const { query } = buildResolverQuery("Wasser", undefined, {})
    const provider = createBlsProviderIfAvailable()

    await provider.lookup(query)
    const second = await provider.lookup(query)

    expect(second!.providerId).toBe("N110000")
  })

  it("an implausible match is never written to the cache in the first place", async () => {
    const { createBlsProviderIfAvailable } = await import("../src/services/providers/bls-provider.js")
    const { buildResolverQuery } = await import("../src/services/resolver-query.js")
    const { sanityCheckNutrients } = await import("../src/services/sanity-check.js")

    cacheWrites.length = 0
    for (const name of ["Wasser", "Mineralwasser", "Salz", "Kartoffeln"]) {
      const { query } = buildResolverQuery(name, undefined, {})
      await createBlsProviderIfAvailable().lookup(query)
      for (const w of cacheWrites) {
        expect(
          sanityCheckNutrients(w.match.nutrients, name).ok,
          `cached "${w.match.productName}" is not possible for "${name}"`,
        ).toBe(true)
      }
      cacheWrites.length = 0
    }
  })
})

describe("the upgrade path a real installation takes", () => {
  it("a recipe that failed on the old build produces complete nutrition after the upgrade", async () => {
    // The cache survives `docker compose up -d --force-recreate`: it lives in the named volume,
    // not the container. This is the scenario that reproduced on the VPS.
    await poisonCacheFor("Wasser")

    const { getRecipe } = await import("../src/services/mealie-client.js")
    ;(getRecipe as any).mockResolvedValue(
      recipe("upgrade-path", 2, [
        ing(500, "g", "Kartoffeln"),
        ing(200, "g", "Karotten"),
        ing(100, "g", "Zwiebeln"),
        ing(10, "g", "Olivenöl"),
        ing(500, "ml", "Wasser"),
        ing(5, "g", "Salz"),
      ]),
    )

    const { runEstimationPipeline } = await import("../src/services/pipeline.js")
    const outcome = await runEstimationPipeline("upgrade-path")

    expect(outcome.status).toBe("estimated")
    const patch = patchCalls[0].patch
    expect(patch.extras?.calorie_estimator_status).toBe("complete")
    expect(JSON.parse(patch.extras?.calorie_estimator_unmatched ?? "[]")).toEqual([])
    expect(Number(patch.nutrition?.calories)).toBeGreaterThan(0)

    const provenance = JSON.parse(patch.extras?.calorie_estimator_provenance ?? "[]")
    const water = provenance.find((p: any) => p.name === "Wasser")
    expect(water.matched).toBe(true)
    expect(water.providerId).toBe("N110000")
  })
})
