import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest"
import { config } from "../src/config.js"
import { initCache } from "../src/utils/cache.js"
import { buildResolverQuery } from "../src/services/resolver-query.js"
import { resolveNutrients } from "../src/services/nutrient-resolver.js"
import { sanityCheckNutrients } from "../src/services/sanity-check.js"
import { loadBlsRecordByCode } from "../src/services/providers/bls-provider.js"
import type { MealieRecipe, MealieIngredient, MealieRecipePatch } from "../src/types.js"

/**
 * Regression cover for a clean-install failure found on v1.0.1.
 *
 * A recipe containing "500 ml Wasser" produced NO nutrition at all. BLS holds both
 * Trinkwasser (N110000, 0 kcal) and Obstbrand/Obstwasser (P752100, 274 kcal — a fruit
 * schnapps). German compounds them identically, so for the query "Wasser" both scored 57 and
 * the tie fell to the schnapps. The resolver's sanity check then correctly refused 274 kcal
 * for "Wasser" — and, because a rejection there discards the whole PROVIDER, BLS was
 * abandoned with 0 kcal water sitting one position down its own ranked list. The ingredient
 * went unmatched, which withheld the entire recipe's nutrition.
 *
 * The bug is not water. It is that nutritional plausibility was a veto applied AFTER a
 * provider had already committed to one candidate, instead of being part of choosing one.
 */

const patchCalls: { slug: string; patch: MealieRecipePatch }[] = []

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
    slug,
    name: slug,
    recipeYield: `${servings * 3} Portionen`,
    recipeServings: servings,
    recipeIngredient: ingredients,
    nutrition: null,
    tags: [],
    extras: {},
    householdId: null,
  }
}

async function resolve(foodName: string) {
  const { query, route } = buildResolverQuery(foodName, undefined, {})
  return resolveNutrients(query, route)
}

beforeAll(async () => {
  await initCache()
})

beforeEach(() => {
  patchCalls.length = 0
  // The reported failure happened with the LLM off: deterministic classification only.
  config.llm.enabled = false
  config.llm.apiKey = ""
  config.llm.judgeEnabled = false
})

describe("the BLS records behind the failure", () => {
  it("both candidates really are in the bundled database, with the nutrients that caused it", async () => {
    const schnapps = await loadBlsRecordByCode("P752100")
    const water = await loadBlsRecordByCode("N110000")

    expect(schnapps?.name).toBe("Obstbrand/Obstwasser")
    expect(schnapps?.nutrients.kcalPer100g).toBe(274)

    expect(water?.name).toBe("Trinkwasser")
    expect(water?.nutrients.kcalPer100g).toBe(0)
  })

  it("the sanity check still rejects the schnapps for a water query — it was right, and stays", () => {
    const schnappsNutrients = {
      kcalPer100g: 274, proteinPer100g: 0, carbsPer100g: 0, fatPer100g: 0,
      saturatedFatPer100g: null, transFatPer100g: null, unsaturatedFatPer100g: null,
      fiberPer100g: null, sugarPer100g: null, sodiumPer100g: null, cholesterolPer100g: null,
    }
    const check = sanityCheckNutrients(schnappsNutrients, "Wasser")
    expect(check.ok).toBe(false)
    expect(check.reason).toContain("274")
  })
})

describe("Wasser resolves to real water, deterministically and without an LLM", () => {
  it("'Wasser' resolves to the BLS drinking-water record, not the 274 kcal schnapps", async () => {
    const resolved = await resolve("Wasser")

    expect(resolved).not.toBeNull()
    expect(resolved!.match.nutrients.kcalPer100g).toBe(0)
    // Provenance must name the record the numbers actually came from.
    expect(resolved!.match.provider).toBe("bls")
    expect(resolved!.match.providerId).toBe("N110000")
    expect(resolved!.match.productName).toBe("Trinkwasser")
  })

  it("never returns the 274 kcal/100 g value for water under any spelling", async () => {
    for (const name of ["Wasser", "wasser", "Trinkwasser", "Leitungswasser"]) {
      const resolved = await resolve(name)
      if (resolved) expect(resolved.match.nutrients.kcalPer100g).not.toBe(274)
    }
  })

  it("does not disturb neighbouring simple German foods", async () => {
    const potato = await resolve("Kartoffeln")
    const oil = await resolve("Olivenöl")
    const salt = await resolve("Salz")

    expect(potato?.match.provider).toBe("bls")
    expect(potato!.match.nutrients.kcalPer100g).toBeGreaterThan(50)
    expect(oil!.match.nutrients.kcalPer100g).toBeGreaterThan(800)
    expect(salt!.match.nutrients.kcalPer100g).toBeLessThanOrEqual(20)
  })
})

describe("the reported recipe, end to end", () => {
  const ingredients = () => [
    ing(500, "g", "Kartoffeln"),
    ing(200, "g", "Karotten"),
    ing(100, "g", "Zwiebeln"),
    ing(10, "g", "Olivenöl"),
    ing(500, "ml", "Wasser"),
    ing(5, "g", "Salz"),
  ]

  it("500 ml Wasser no longer withholds the whole recipe", async () => {
    const { getRecipe } = await import("../src/services/mealie-client.js")
    ;(getRecipe as any).mockResolvedValue(recipe("kartoffeln-mit-wasser", 2, ingredients()))

    const { runEstimationPipeline } = await import("../src/services/pipeline.js")
    const outcome = await runEstimationPipeline("kartoffeln-mit-wasser")

    expect(outcome.status).toBe("estimated")

    const patch = patchCalls[0].patch
    expect(patch.extras?.calorie_estimator_status).toBe("complete")
    expect(patch.nutrition?.calories).toBeTruthy()
    expect(Number(patch.nutrition?.calories)).toBeGreaterThan(0)

    // Every ingredient resolved, water included.
    expect(JSON.parse(patch.extras?.calorie_estimator_unmatched ?? "[]")).toEqual([])

    // Water contributed a real record and zero calories.
    const provenance = JSON.parse(patch.extras?.calorie_estimator_provenance ?? "[]")
    const water = provenance.find((p: any) => p.name === "Wasser")
    expect(water).toBeTruthy()
    expect(water.matched).toBe(true)
    expect(water.provider).toBe("bls")
    expect(water.providerId).toBe("N110000")
    expect(water.grams).toBe(500)

    // Mealie write safety is unchanged.
    expect(Object.keys(patch).sort()).toEqual(["extras", "nutrition", "tags"])
  })

  it("water adds no calories, so the total matches the same recipe without it", async () => {
    const { estimateRecipe } = await import("../src/services/estimator.js")

    const withWater = await estimateRecipe(recipe("with-water", 2, ingredients()))
    const withoutWater = await estimateRecipe(
      recipe("without-water", 2, ingredients().filter((i) => i.food?.name !== "Wasser")),
    )

    expect(withWater.completeness).toBe("complete")
    expect(withoutWater.completeness).toBe("complete")
    expect(withWater.totalNutrients.kcalPer100g).toBeCloseTo(withoutWater.totalNutrients.kcalPer100g!, 4)
  })

  it("divides by recipeServings exactly once", async () => {
    const { estimateRecipe } = await import("../src/services/estimator.js")
    const result = await estimateRecipe(recipe("serving-division", 2, ingredients()))

    expect(result.totalNutrients.kcalPer100g).toBeGreaterThan(0)
    // Divided exactly once, then rounded on the way out (Mealie receives integers).
    expect(result.perServingNutrients.kcalPer100g)
      .toBe(Math.round(result.totalNutrients.kcalPer100g! / 2))
  })
})

describe("the generic defect: a provider must not commit to an implausible candidate", () => {
  it("a sanity-rejected top candidate no longer costs the provider its remaining candidates", async () => {
    // This is the general statement of the bug. "Wasser" is the case that exposed it: the wrong
    // candidate and the right one sit at the SAME score, so nothing but plausibility separates
    // them, and before the fix the provider answered with the one that could not be true.
    const resolved = await resolve("Wasser")

    expect(resolved).not.toBeNull()
    expect(resolved!.match.provider).toBe("bls")

    // Whatever a provider returns must survive the resolver's own check — that check is unchanged
    // and still has the final word.
    expect(sanityCheckNutrients(resolved!.match.nutrients, "Wasser").ok).toBe(true)
  })
})
