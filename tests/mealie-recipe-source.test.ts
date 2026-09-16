import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest"
import { config } from "../src/config.js"
import { initCache } from "../src/utils/cache.js"
import {
  MealieRecipeProvider, nutrientsPer100g, yieldInGrams, sourceFingerprint, __resetRecipeIndexForTests,
} from "../src/services/providers/mealie-recipe-provider.js"
import type { MealieRecipe, ProviderMatch } from "../src/types.js"

/**
 * The user's own Mealie recipes as a nutrition source for homemade ingredients.
 *
 * The real case: Butter Chicken lists 100 g of "Tikka-Paste"; the user has a Tikka-Paste recipe
 * totalling 2595 kcal over an 800 g yield; production was estimating it at 100 kcal/100 g from an
 * LLM guess — a threefold understatement of the most calorie-dense thing in the dish.
 */
beforeAll(async () => {
  await initCache()
})

/** Mirrors the real Tikka-Paste recipe, including Mealie's own yield representation. */
const TIKKA: MealieRecipe = {
  slug: "tikka-paste-1",
  name: "Tikka-Paste",
  recipeYield: "g",
  recipeYieldQuantity: 800,
  recipeServings: 1,
  recipeIngredient: [],
  nutrition: {
    calories: "2595", proteinContent: "29", carbohydrateContent: "88", fatContent: "239",
    saturatedFatContent: "33", transFatContent: "0", unsaturatedFatContent: "206",
    fiberContent: "65", sugarContent: "29", sodiumContent: "12017", cholesterolContent: "0",
  },
  tags: [], extras: null,
}

// The Mealie client speaks node:http, not fetch, so the module itself is the seam.
const served: Record<string, MealieRecipe> = {}
let recipeReads = 0
let indexReads = 0

vi.mock("../src/services/mealie-client.js", () => ({
  listRecipeNames: vi.fn(async () => {
    indexReads++
    return Object.values(served).map((r) => ({ slug: r.slug, name: r.name }))
  }),
  getRecipe: vi.fn(async (slug: string) => {
    recipeReads++
    const found = served[slug]
    if (!found) throw new Error(`404 ${slug}`)
    return found
  }),
  getRecipeHouseholdId: vi.fn(() => null),
  patchRecipe: vi.fn(async () => {}),
  getOrCreateTags: vi.fn(async () => []),
  getAllRecipes: vi.fn(async () => Object.keys(served)),
}))

function stubMealie(recipes: MealieRecipe[]): void {
  recipeReads = 0
  indexReads = 0
  for (const k of Object.keys(served)) delete served[k]
  for (const r of recipes) served[r.slug] = r
  __resetRecipeIndexForTests()
}

beforeEach(() => {
  config.mealieRecipeSource.enabled = true
  config.mealieRecipeSource.indexTtlMs = 300_000
  config.mealieRecipeSource.maxDepth = 1
  // Deliberately NOT vi.restoreAllMocks(): it resets the vi.fn()s inside the module mock above,
  // which would leave every Mealie call returning undefined.
})

afterEach(() => {
  __resetRecipeIndexForTests()
})

const provider = new MealieRecipeProvider()

function lookup(name: string, over: Record<string, unknown> = {}): Promise<ProviderMatch | null> {
  return provider.lookup({
    foodName: name, structuredName: name, canonicalGerman: name, brand: null, category: null,
    state: "unknown", foodType: "processed_single_food", coreFoodGerman: name, coreFoodEnglish: name,
    route: "generic", householdId: null, ancestorSlugs: ["butter-chicken"],
    ...over,
  } as never)
}

describe("deriving nutrition per mass from a source recipe", () => {
  it("reads Mealie's own yield representation, and only when it is a mass", () => {
    expect(yieldInGrams({ recipeYield: "g", recipeYieldQuantity: 800 })).toBe(800)
    expect(yieldInGrams({ recipeYield: "kg", recipeYieldQuantity: 1.2 })).toBe(1200)
    // A count or a portion is not a mass. Cooked weight is never inferred from ingredient weights:
    // evaporation makes that unreliable in exactly the cases that matter — sauces and pastes.
    expect(yieldInGrams({ recipeYield: "Portionen", recipeYieldQuantity: 4 })).toBeNull()
    expect(yieldInGrams({ recipeYield: "loaf", recipeYieldQuantity: 1 })).toBeNull()
    expect(yieldInGrams({ recipeYield: "g", recipeYieldQuantity: null })).toBeNull()
    expect(yieldInGrams({ recipeYield: null, recipeYieldQuantity: 800 })).toBeNull()
  })

  it("converts the whole recipe to nutrients per 100 g", () => {
    const derived = nutrientsPer100g(TIKKA)!
    expect(derived.yieldGrams).toBe(800)
    // 2595 kcal over 800 g -> 324.4 per 100 g. The LLM guess it replaces was 100.
    expect(derived.nutrients.kcalPer100g).toBeCloseTo(324.375, 2)
    expect(derived.nutrients.fatPer100g).toBeCloseTo(29.875, 2)
    // Mealie reports sodium in mg; NutrientSet is grams per 100 g throughout.
    expect(derived.nutrients.sodiumPer100g).toBeCloseTo(1.502, 2)
  })

  it("multiplies by servings, because Mealie's nutrition block is per serving", () => {
    const fourPortions: MealieRecipe = {
      ...TIKKA, recipeServings: 4,
      nutrition: { ...TIKKA.nutrition!, calories: "649" }, // same ~2595 kcal total
    }
    expect(nutrientsPer100g(fourPortions)!.nutrients.kcalPer100g).toBeCloseTo(324.5, 0)
  })

  it("declines a recipe that cannot support the calculation", () => {
    expect(nutrientsPer100g({ ...TIKKA, nutrition: null })).toBeNull()
    expect(nutrientsPer100g({ ...TIKKA, recipeYield: "Portionen" })).toBeNull()
    expect(nutrientsPer100g({ ...TIKKA, recipeServings: 0 })).toBeNull()
  })
})

describe("matching an ingredient to one of the user's recipes", () => {
  it("resolves Tikka-Paste and records where the nutrients came from", async () => {
    stubMealie([TIKKA])
    const m = await lookup("Tikka-Paste")
    expect(m).not.toBeNull()
    expect(m!.provider).toBe("mealie-recipe")
    expect(m!.providerId).toBe("tikka-paste-1")
    expect(m!.sourceRecipeSlug).toBe("tikka-paste-1")
    expect(m!.sourceRecipeYieldGrams).toBe(800)
    expect(m!.matchReason).toBe("exact-recipe-name")
    expect(m!.nutrients.kcalPer100g).toBeCloseTo(324.375, 2)
    // 100 g of the paste therefore contributes ~324 kcal, against the ~100 the LLM guessed.
    expect((m!.nutrients.kcalPer100g! * 100) / 100).toBeCloseTo(324.375, 2)
  })

  it("matches on the slug spelling too", async () => {
    stubMealie([{ ...TIKKA, name: "Tikka Paste (1)" }])
    expect((await lookup("tikka paste 1"))?.providerId).toBe("tikka-paste-1")
  })

  it("is conservative: a name that merely CONTAINS the recipe's does not match", async () => {
    stubMealie([TIKKA])
    for (const name of ["Tikka", "Tikka-Paste Marinade", "Chicken Tikka Masala", "Paste"]) {
      expect(await lookup(name), name).toBeNull()
    }
  })

  it("declines when the source recipe has no usable yield, rather than guessing", async () => {
    stubMealie([{ ...TIKKA, recipeYield: "Portionen", recipeYieldQuantity: 4 }])
    expect(await lookup("Tikka-Paste")).toBeNull()
  })

  it("declines when the source recipe has no nutrition yet", async () => {
    stubMealie([{ ...TIKKA, nutrition: null }])
    expect(await lookup("Tikka-Paste")).toBeNull()
  })

  it("is silent when disabled", async () => {
    stubMealie([TIKKA])
    config.mealieRecipeSource.enabled = false
    expect(await lookup("Tikka-Paste")).toBeNull()
  })
})

describe("cycles and depth are refused, not merely unlikely", () => {
  it("a recipe never resolves through itself", async () => {
    stubMealie([TIKKA])
    expect(await lookup("Tikka-Paste", { ancestorSlugs: ["tikka-paste-1"] })).toBeNull()
  })

  it("a mutual dependency terminates", async () => {
    // A uses B, B uses A: resolving B from inside A must not reach back to A.
    const a: MealieRecipe = { ...TIKKA, slug: "recipe-a", name: "Recipe A" }
    const b: MealieRecipe = { ...TIKKA, slug: "recipe-b", name: "Recipe B" }
    stubMealie([a, b])
    expect(await lookup("Recipe A", { ancestorSlugs: ["recipe-b", "recipe-a"] })).toBeNull()
    // The other direction still resolves: refusing a cycle must not disable the feature.
    expect(await lookup("Recipe B", { ancestorSlugs: ["recipe-a"] })).not.toBeNull()
  })

  it("stops at the configured depth", async () => {
    stubMealie([TIKKA])
    config.mealieRecipeSource.maxDepth = 1
    expect(await lookup("Tikka-Paste", { ancestorSlugs: ["outer", "inner"] })).toBeNull()
  })
})

describe("a dependent recipe cannot hold a stale value forever", () => {
  it("the fingerprint changes when the source's nutrition changes", () => {
    const before = sourceFingerprint(TIKKA)
    const after = sourceFingerprint({ ...TIKKA, nutrition: { ...TIKKA.nutrition!, calories: "3000" } })
    expect(after).not.toBe(before)
  })

  it("the fingerprint changes when the source is re-portioned", () => {
    const before = sourceFingerprint(TIKKA)
    expect(sourceFingerprint({ ...TIKKA, recipeYieldQuantity: 600 })).not.toBe(before)
    expect(sourceFingerprint({ ...TIKKA, recipeServings: 2 })).not.toBe(before)
  })

  it("the fingerprint is stable when nothing relevant changed", () => {
    expect(sourceFingerprint({ ...TIKKA, name: "Renamed" })).toBe(sourceFingerprint(TIKKA))
  })
})

describe("the recipe index is reused rather than refetched per ingredient", () => {
  it("reads the recipe list once for a run of lookups", async () => {
    stubMealie([TIKKA])
    await lookup("Tikka-Paste")
    const afterFirst = recipeReads
    await lookup("Tikka-Paste")
    await lookup("something else entirely")
    // One full-recipe read per HIT, and the name index built exactly once.
    expect(recipeReads - afterFirst).toBe(1)
    expect(indexReads).toBe(1)
  })
})
