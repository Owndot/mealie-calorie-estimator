import { describe, it, expect, vi, beforeEach } from "vitest"
import { config } from "../src/config.js"
import type { MealieRecipe, MealieIngredient, MealieRecipePatch } from "../src/types.js"

const patchCalls: { slug: string; patch: MealieRecipePatch }[] = []

vi.mock("../src/services/mealie-client.js", () => ({
  getRecipe: vi.fn(),
  getRecipeHouseholdId: vi.fn(() => null),
  patchRecipe: vi.fn(async (slug: string, patch: MealieRecipePatch) => {
    patchCalls.push({ slug, patch })
  }),
  getOrCreateTags: vi.fn(async (names: string[]) =>
    names.map((name) => ({ id: name, name, slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), groupId: null })),
  ),
}))

function ing(quantity: number, unitName: string, foodName: string, overrides: Partial<MealieIngredient> = {}): MealieIngredient {
  return {
    quantity,
    unit: { id: unitName, name: unitName, pluralName: unitName, abbreviation: null, standardQuantity: null, standardUnit: null },
    food: { id: foodName, name: foodName, pluralName: null, aliases: [] },
    note: null,
    display: `${quantity} ${unitName} ${foodName}`,
    title: null,
    originalText: `${quantity} ${unitName} ${foodName} (vom Discounter, @insta_handle)`, // must never affect the result
    ...overrides,
  }
}

function recipe(slug: string, servings: number, ingredients: MealieIngredient[]): MealieRecipe {
  return {
    slug,
    name: slug,
    recipeYield: `${servings * 3} Portionen`, // deliberately wrong/unused — must never affect division
    recipeServings: servings,
    recipeIngredient: ingredients,
    nutrition: null,
    tags: [],
    extras: {},
    householdId: null,
  }
}

beforeEach(() => {
  patchCalls.length = 0
  config.llm.enabled = false
  config.llm.apiKey = ""
  config.usda.apiKey = ""
})

describe("realistic German recipes — end to end through the full pipeline", () => {
  it("Kartoffelsuppe (potato soup): resolves all generic ingredients, divides by recipeServings only, writes only nutrition/extras/tags", async () => {
    const { getRecipe } = await import("../src/services/mealie-client.js")
    ;(getRecipe as any).mockResolvedValue(
      recipe("kartoffelsuppe", 4, [
        ing(800, "g", "Kartoffel"),
        ing(1, "Stück", "Zwiebel"),
        ing(2, "Zehe", "Knoblauch"),
        ing(200, "ml", "Sahne"),
        ing(1, "TL", "Salz"),
      ]),
    )

    const { runEstimationPipeline } = await import("../src/services/pipeline.js")
    const outcome = await runEstimationPipeline("kartoffelsuppe")

    expect(outcome.status).toBe("estimated")
    const patch = patchCalls[0].patch

    // Mealie write safety: only nutrition/extras/tags are ever touched.
    expect(Object.keys(patch).sort()).toEqual(["extras", "nutrition", "tags"])

    expect(patch.nutrition?.calories).toBeTruthy()
    expect(Number(patch.nutrition?.calories)).toBeGreaterThan(0)
    expect(patch.extras?.calorie_estimator_status).toBe("complete")
    expect(patch.extras?.calorie_estimator_hash).toBeTruthy()

    // Never leaked from originalText.
    const patchJson = JSON.stringify(patch)
    expect(patchJson).not.toContain("insta_handle")
    expect(patchJson).not.toContain("Discounter")
  })

  it("Kuchenteig (cake batter): 1 EL Öl and 1 EL Mehl resolve to different gram weights, contributing different calories", async () => {
    const { getRecipe } = await import("../src/services/mealie-client.js")
    ;(getRecipe as any).mockResolvedValue(
      recipe("kuchenteig", 8, [
        ing(1, "EL", "Olivenöl"),
        ing(1, "EL", "Mehl"),
      ]),
    )

    const { estimateRecipe } = await import("../src/services/estimator.js")
    const recipeObj = recipe("kuchenteig", 8, [ing(1, "EL", "Olivenöl"), ing(1, "EL", "Mehl")])
    const result = await estimateRecipe(recipeObj)

    const oilIngredient = result.matchedIngredients.find((i) => i.name === "Olivenöl")
    const flourIngredient = result.matchedIngredients.find((i) => i.name === "Mehl")

    expect(oilIngredient?.grams).not.toBe(flourIngredient?.grams)
    expect(oilIngredient?.gramsEstimated).toBe(true)
    expect(flourIngredient?.gramsEstimated).toBe(true)
  })

  it("Hähnchen mit Reis: sodium is written to Mealie in milligrams, not raw internal grams", async () => {
    const { getRecipe } = await import("../src/services/mealie-client.js")
    ;(getRecipe as any).mockResolvedValue(
      recipe("haehnchen-mit-reis", 2, [
        ing(300, "g", "Hähnchenbrust"),
        ing(200, "g", "Reis"),
      ]),
    )

    const { runEstimationPipeline } = await import("../src/services/pipeline.js")
    await runEstimationPipeline("haehnchen-mit-reis")

    const patch = patchCalls[0].patch
    const sodiumMg = Number(patch.nutrition?.sodiumContent)
    // Hähnchenbrust alone carries ~0.074g/100g sodium * 300g = 0.222g = 222mg, plus rice's trace
    // sodium, over 2 servings. Should land in the tens-of-milligrams range, not 0.0x (raw grams).
    expect(sodiumMg).toBeGreaterThan(10)
    expect(sodiumMg).toBeLessThan(1000)
  })

  it("Salzkartoffeln with an unresolvable exotic main ingredient: nutrition is withheld, not silently reported as complete", async () => {
    const { getRecipe } = await import("../src/services/mealie-client.js")
    ;(getRecipe as any).mockResolvedValue(
      recipe("salzkartoffeln-exotisch", 4, [
        ing(200, "g", "Kartoffel"),
        ing(600, "g", "vollkommen-unbekannte-zutat-xyz"),
      ]),
    )

    const { runEstimationPipeline } = await import("../src/services/pipeline.js")
    await runEstimationPipeline("salzkartoffeln-exotisch")

    const patch = patchCalls[0].patch
    expect(patch.nutrition).toEqual({})
    expect(patch.extras?.calorie_estimator_status).toBe("withheld")
  })
})
