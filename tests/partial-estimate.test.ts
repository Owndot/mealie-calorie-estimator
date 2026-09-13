import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { config } from "../src/config.js"
import { estimateRecipe, buildNutritionPatch, computeIngredientHash } from "../src/services/estimator.js"
import { estimateAndTag } from "../src/services/tagging.js"
import { getOrCreateTags, patchRecipe } from "../src/services/mealie-client.js"
import type { MealieIngredient, MealieNutrition, MealieRecipe } from "../src/types.js"

vi.mock("../src/services/off-client.js", () => ({ lookupNutrients: vi.fn(async () => ({ matched: false, nutrients: null, productName: null })) }))
vi.mock("../src/services/llm-estimator.js", () => ({ estimateGrams: vi.fn(async () => null), estimateNutrients: vi.fn(async () => null) }))
vi.mock("../src/services/mealie-client.js", () => ({
  patchRecipe: vi.fn(async () => {}),
  getOrCreateTags: vi.fn(async (names: string[]) => names.map(name => ({ id: name, name, slug: name, groupId: null }))),
}))

function ingredient(name: string, quantity: number | null = 100, unitName = "g"): MealieIngredient {
  return {
    food: { id: name, name, pluralName: null, aliases: [] }, quantity,
    unit: { id: "unit", name: unitName, abbreviation: null, pluralName: null, standardUnit: null, standardQuantity: null },
    display: name, note: null, title: null, originalText: null,
  }
}
const existing: MealieNutrition = {
  calories: "900", proteinContent: "30", carbohydrateContent: "100", fatContent: "40",
  saturatedFatContent: "10", transFatContent: "0", unsaturatedFatContent: "30",
  fiberContent: "8", sugarContent: "5", sodiumContent: "700", cholesterolContent: "20",
}
function recipe(missing = "Walnüsse", nutrition: MealieNutrition | null = existing): MealieRecipe {
  return {
    slug: "partial", name: "Partial", recipeIngredient: [ingredient("Basmati-Reis"), ingredient(missing)],
    recipeYield: "1 Portion", recipeServings: 1, nutrition,
    tags: [{ id: "heavy", name: "Calories:Heavy", slug: "calories-heavy", groupId: null }],
    extras: { custom: "preserved", calorie_estimator_hash: "last-complete", calorie_estimator_tags: '["calories-heavy"]', calorie_estimator_total_kcal: "900" },
  }
}
const originalPolicy = config.estimate.partialPolicy
beforeEach(() => { vi.clearAllMocks(); config.estimate.partialPolicy = "withhold" })
afterEach(() => { config.estimate.partialPolicy = originalPolicy })

describe("partial-estimate safety", () => {
  it.each(["Walnüsse", "Walnussöl", "Unbekannte Käsemischung"])("withholds nutrition when 100 g %s has no profile", async name => {
    const input = recipe(name)
    const result = await estimateRecipe(input)
    expect(result.partial).toBe(true)
    expect(result.matchedIngredients[1]).toMatchObject({ name, grams: 100, matched: false, nutrients: null })
    expect(result.totals?.kcal).toBe(365) // Still available for diagnosis, never a complete meal total.
    const patch = buildNutritionPatch(result, "attempt", input.recipeYield, input.nutrition)
    expect(patch.nutrition).toEqual({})
    expect(patch.extras).toMatchObject({ calorie_estimator_partial: "true", calorie_estimator_nutrition_status: "partial-withheld", calorie_estimator_partial_total_kcal: "365", calorie_estimator_attempt_hash: "attempt", calorie_estimator_hash: "" })
    expect(patch.extras.calorie_estimator_total_kcal).toBeUndefined()
    expect(JSON.parse(patch.extras.calorie_estimator_unmatched_details)[0]).toMatchObject({ name, grams: 100 })
  })

  it.each(["withhold", "fill-empty"] as const)("never sends nutrition or replacement tags for existing values under %s", async policy => {
    config.estimate.partialPolicy = policy
    const input = recipe()
    const result = await estimateAndTag(input, "new-hash", "household")
    const sent = vi.mocked(patchRecipe).mock.calls[0][1]
    expect(sent).not.toHaveProperty("nutrition")
    expect(sent).not.toHaveProperty("tags")
    expect(getOrCreateTags).not.toHaveBeenCalled()
    expect(sent.extras).toMatchObject({ custom: "preserved", calorie_estimator_total_kcal: "900", calorie_estimator_tags: '["calories-heavy"]', calorie_estimator_partial: "true", calorie_estimator_hash: "" })
    expect(result.calories).toBeNull()
    expect({ ...input.nutrition, ...sent.nutrition }).toEqual(existing)
  })

  it("withholds partial nutrition even for an empty recipe by default", async () => {
    await estimateAndTag(recipe("Walnüsse", null), "attempt")
    expect(vi.mocked(patchRecipe).mock.calls[0][1]).not.toHaveProperty("nutrition")
  })

  it("allows an explicitly opted-in partial result only into wholly empty nutrition", async () => {
    config.estimate.partialPolicy = "fill-empty"
    const input = recipe("Walnüsse", null)
    await estimateAndTag(input, "attempt")
    const sent = vi.mocked(patchRecipe).mock.calls[0][1]
    expect(sent.nutrition?.calories).toBe("365")
    expect(sent.extras).toMatchObject({ calorie_estimator_partial: "true", calorie_estimator_nutrition_status: "partial-written", calorie_estimator_hash: "" })
    expect(sent).not.toHaveProperty("tags")
    expect(getOrCreateTags).not.toHaveBeenCalled()
  })

  it("does not mix partial calories into a recipe with only existing sodium", async () => {
    config.estimate.partialPolicy = "fill-empty"
    const nutrition = Object.fromEntries(Object.keys(existing).map(key => [key, null])) as unknown as MealieNutrition
    nutrition.sodiumContent = "700"
    await estimateAndTag(recipe("Walnüsse", nutrition), "attempt")
    expect(vi.mocked(patchRecipe).mock.calls[0][1]).not.toHaveProperty("nutrition")
  })

  it("fails closed when existing nutrition is not supplied to the patch builder", async () => {
    config.estimate.partialPolicy = "fill-empty"
    const result = await estimateRecipe(recipe())
    expect(buildNutritionPatch(result, "attempt", "1 Portion").nutrition).toEqual({})
  })

  it.each([null, -1, Number.NaN])("marks invalid/unquantified quantities %s as partial", async quantity => {
    const input = recipe()
    input.recipeIngredient[1].quantity = quantity
    const result = await estimateRecipe(input)
    expect(result.partial).toBe(true)
    expect(result.unmatchedIngredients).toContain("Walnüsse")
    expect(buildNutritionPatch(result, "hash", "1 Portion").nutrition).toEqual({})
  })

  it("does not count a section heading as an unmatched ingredient", async () => {
    const input = recipe()
    input.recipeIngredient[1] = { ...ingredient(""), food: null, quantity: null, display: "", title: "For the sauce" }
    expect((await estimateRecipe(input)).partial).toBe(false)
  })

  it("marks unknown weights as partial", async () => {
    const input = recipe()
    input.recipeIngredient[1].unit!.name = "Handvoll"
    const result = await estimateRecipe(input)
    expect(result.partial).toBe(true)
    expect(result.matchedIngredients[1].grams).toBeNull()
  })

  it("clears partial diagnostics and writes complete results after recovery", async () => {
    const input = recipe()
    input.recipeIngredient = [ingredient("Basmati-Reis")]
    input.extras = { ...input.extras, calorie_estimator_partial: "true", calorie_estimator_nutrition_status: "partial-withheld", calorie_estimator_warnings: '["Partial estimate"]' }
    await estimateAndTag(input, "complete-hash")
    const sent = vi.mocked(patchRecipe).mock.calls[0][1]
    expect(sent.nutrition?.calories).toBe("365")
    expect(sent.extras).toMatchObject({ calorie_estimator_partial: "false", calorie_estimator_nutrition_status: "complete", calorie_estimator_hash: "complete-hash", calorie_estimator_warnings: "[]", calorie_estimator_partial_total_kcal: "", calorie_estimator_unmatched: "[]", custom: "preserved" })
    expect(getOrCreateTags).toHaveBeenCalledOnce()
  })

  it("changes the recipe hash when the partial policy changes", () => {
    const input = recipe()
    const first = computeIngredientHash(input)
    config.estimate.partialPolicy = "fill-empty"
    expect(computeIngredientHash(input)).not.toBe(first)
  })
})

it("does not claim a partial write when nothing can be written", async () => {
  config.estimate.partialPolicy = "fill-empty"
  const input = recipe("Walnüsse", null)
  input.recipeIngredient = [ingredient("Walnüsse")]
  await estimateAndTag(input, "attempt")
  const sent = vi.mocked(patchRecipe).mock.calls[0][1]
  expect(sent).not.toHaveProperty("nutrition")
  expect(sent.extras?.calorie_estimator_nutrition_status).toBe("partial-withheld")
})

it("does not assume an unknown small ingredient is negligible", async () => {
  const input = recipe()
  input.recipeIngredient[1].quantity = 0.1
  const result = await estimateRecipe(input)
  expect(result.partial).toBe(true)
  expect(buildNutritionPatch(result, "attempt", input.recipeYield, input.nutrition).nutrition).toEqual({})
})

it("treats whitespace-only existing fields as empty for the opt-in policy", async () => {
  config.estimate.partialPolicy = "fill-empty"
  const empty = Object.fromEntries(Object.keys(existing).map(key => [key, " "])) as unknown as MealieNutrition
  await estimateAndTag(recipe("Walnüsse", empty), "attempt")
  expect(vi.mocked(patchRecipe).mock.calls[0][1].nutrition?.calories).toBe("365")
})

// These existing cases exercise the optional tagging behavior.
config.estimate.autoTags = true
