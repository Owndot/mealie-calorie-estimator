import Fastify from "fastify"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { webhookRoutes } from "../src/routes/webhook.js"
import { estimateRoutes } from "../src/routes/estimate.js"
import { backfillRoutes } from "../src/routes/backfill.js"
import { computeIngredientHash, estimateRecipe } from "../src/services/estimator.js"
import { lookupNutrients } from "../src/services/off-client.js"
import { estimateGrams, estimateNutrients } from "../src/services/llm-estimator.js"
import { getRecipe, getAllRecipes, patchRecipe } from "../src/services/mealie-client.js"
import { logger } from "../src/utils/logger.js"
import { config } from "../src/config.js"
import type { MealieIngredient, MealieRecipe } from "../src/types.js"

vi.mock("../src/services/off-client.js", () => ({ lookupNutrients: vi.fn(async () => ({ matched: false, nutrients: null, productName: null })) }))
vi.mock("../src/services/llm-estimator.js", () => ({ estimateGrams: vi.fn(async () => null), estimateNutrients: vi.fn(async () => null) }))
vi.mock("../src/services/mealie-client.js", () => ({ getRecipe: vi.fn(), getAllRecipes: vi.fn(), patchRecipe: vi.fn(), getRecipeHouseholdId: vi.fn(), getOrCreateTags: vi.fn() }))
vi.mock("../src/utils/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }))

function ingredient(name: string, unit = "g"): MealieIngredient {
  return { quantity: 100, food: { id: "food", name, pluralName: null, aliases: [] },
    unit: { id: "unit", name: unit, abbreviation: null, pluralName: null, standardQuantity: null, standardUnit: null },
    note: null, display: name, title: null, originalText: null, referenceId: "ingredient" }
}
function recipe(): MealieRecipe {
  return { slug: "loop", name: "Loop", recipeServings: 4, recipeYield: "4 Portionen",
    recipeIngredient: [ingredient("Basmati-Reis"), ingredient("Garam Masala")],
    recipeInstructions: [{ text: "Kochen", ingredientReferences: [{ referenceId: "ingredient" }] }],
    nutrition: null, extras: {}, tags: [] }
}
const originalPolicy = config.estimate.partialPolicy
let current: MealieRecipe
let app: ReturnType<typeof Fastify>
beforeEach(async () => {
  vi.clearAllMocks()
  config.estimate.partialPolicy = "withhold"
  current = recipe()
  vi.mocked(getRecipe).mockImplementation(async () => structuredClone(current))
  vi.mocked(getAllRecipes).mockResolvedValue([current.slug])
  vi.mocked(patchRecipe).mockImplementation(async (_slug, patch) => {
    current = { ...current, ...patch, nutrition: patch.nutrition ? { ...current.nutrition, ...patch.nutrition } as MealieRecipe["nutrition"] : current.nutrition }
  })
  app = Fastify()
  await app.register(webhookRoutes)
  await app.register(estimateRoutes)
  await app.register(backfillRoutes)
})
afterEach(async () => { await app.close(); config.estimate.partialPolicy = originalPolicy })
async function webhook() {
  const response = await app.inject({ method: "POST", url: "/webhook", payload: {
    event_type: "recipe_updated", document_data: JSON.stringify({ document_type: "recipe", operation: "update", recipe_slug: current.slug }),
  } })
  expect(response.statusCode).toBe(202)
  // Drain the background handler, including all mocked async lookups/patches.
  await new Promise<void>(resolve => setImmediate(resolve))
  expect(logger.error).not.toHaveBeenCalled()
}

describe("partial webhook idempotency", () => {
  it.each(["withhold", "fill-empty"] as const)("skips its own %s patch with no further lookup or patch", async policy => {
    config.estimate.partialPolicy = policy
    await webhook()
    expect(lookupNutrients).toHaveBeenCalledOnce()
    expect(estimateNutrients).toHaveBeenCalledOnce()
    expect(patchRecipe).toHaveBeenCalledOnce()
    expect(current.extras?.calorie_estimator_nutrition_status).toBe(policy === "withhold" ? "partial-withheld" : "partial-written")
    expect(current.extras?.calorie_estimator_attempt_hash).toBe(computeIngredientHash(current))
    vi.clearAllMocks()
    await webhook()
    expect(lookupNutrients).not.toHaveBeenCalled()
    expect(estimateNutrients).not.toHaveBeenCalled()
    expect(estimateGrams).not.toHaveBeenCalled()
    expect(patchRecipe).not.toHaveBeenCalled()
    expect(logger.info).toHaveBeenCalledWith(expect.any(Object), "Partial estimate already attempted for unchanged recipe; skipping")
  })

  it("retries once after an ingredient changes", async () => {
    await webhook()
    const firstHash = current.extras!.calorie_estimator_attempt_hash
    current.recipeIngredient[1].quantity = 200
    await webhook()
    expect(lookupNutrients).toHaveBeenCalledTimes(2)
    expect(patchRecipe).toHaveBeenCalledTimes(2)
    expect(current.extras!.calorie_estimator_attempt_hash).not.toBe(firstHash)
    await webhook()
    expect(patchRecipe).toHaveBeenCalledTimes(2)
  })

  it.each(["/estimate", "/backfill"])("allows explicit %s to retry unchanged partial input", async url => {
    await webhook()
    const hash = current.extras!.calorie_estimator_attempt_hash
    const response = await app.inject({ method: "POST", url, payload: { content: { slug: current.slug } } })
    expect(response.statusCode).toBe(202)
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(logger.error).not.toHaveBeenCalled()
    expect(patchRecipe).toHaveBeenCalledTimes(2)
    expect(lookupNutrients).toHaveBeenCalledTimes(2)
    expect(current.extras!.calorie_estimator_attempt_hash).toBe(hash)
    await webhook()
    expect(patchRecipe).toHaveBeenCalledTimes(2)
  })
})

describe("stable estimator input hashes", () => {
  it("ignores output, API metadata, object key order and regenerated IDs with unchanged links", () => {
    const before = computeIngredientHash(current)
    current.extras = { calorie_estimator_attempt_hash: before, arbitrary: "changed" }
    current.nutrition = { calories: "123" } as MealieRecipe["nutrition"]
    current.tags = [{ name: "New", slug: "new", id: "tag", groupId: null }]
    current.recipeIngredient.forEach(ing => {
      ing.unit = { ...Object.fromEntries(Object.entries(ing.unit!).reverse()), id: "new-unit", pluralName: "grams" } as MealieIngredient["unit"]
      ing.referenceId = "regenerated"
    })
    current.recipeInstructions = [{ ingredientReferences: [{ referenceId: "regenerated" }], text: "Kochen", id: "new-step" } as NonNullable<MealieRecipe["recipeInstructions"]>[number]]
    expect(computeIngredientHash(current)).toBe(before)
    expect(computeIngredientHash(structuredClone(current))).toBe(before)
  })
  it.each([
    (r: MealieRecipe) => { r.recipeIngredient[0].food!.name = "Kidneybohnen" },
    (r: MealieRecipe) => { r.recipeIngredient[0].quantity = 101 },
    (r: MealieRecipe) => { r.recipeIngredient[0].unit!.name = "kg" },
    (r: MealieRecipe) => { r.recipeIngredient[0].unit!.abbreviation = "kg" },
    (r: MealieRecipe) => { r.recipeIngredient[0].unit!.standardQuantity = 5 },
    (r: MealieRecipe) => { r.recipeIngredient[0].unit!.standardUnit = "gram" },
    (r: MealieRecipe) => { r.recipeIngredient[0].note = "gekocht" },
    (r: MealieRecipe) => { r.recipeIngredient[0].originalText = "gekochter Reis" },
    (r: MealieRecipe) => { r.recipeInstructions = ["Über Nacht einweichen"] },
    (r: MealieRecipe) => { r.recipeIngredient[0].referenceId = "unlinked" },
    (r: MealieRecipe) => { r.recipeServings = 5 },
    (r: MealieRecipe) => { r.recipeYield = "5 Portionen" },
  ])("changes when an estimator input changes (%#)", change => {
    const before = computeIngredientHash(current)
    change(current)
    expect(computeIngredientHash(current)).not.toBe(before)
  })
  it("includes relevant configuration", () => {
    const before = computeIngredientHash(current)
    const model = config.llm.model
    try { config.llm.model = "another-model"; expect(computeIngredientHash(current)).not.toBe(before) }
    finally { config.llm.model = model }
  })
})

describe("water and unknown spice weights", () => {
  it.each(["Wasser", "water"])("estimates %s deterministically with zero nutrients", async name => {
    current.recipeIngredient = [ingredient(name, "ml")]
    const result = await estimateRecipe(current)
    expect(result.partial).toBe(false)
    expect(result.matchedIngredients[0]).toMatchObject({ grams: 100, source: "deterministic" })
    expect(result.totals).toMatchObject({ kcal: 0, proteinG: 0, carbsG: 0, fatG: 0, sodiumMg: 0 })
    expect(lookupNutrients).not.toHaveBeenCalled()
    expect(estimateNutrients).not.toHaveBeenCalled()
    expect(estimateGrams).not.toHaveBeenCalled()
  })
  it("does not invent grams for unitless Garam Masala and skips its own partial patch", async () => {
    current.recipeIngredient[1].quantity = 1
    current.recipeIngredient[1].unit = null
    await webhook()
    expect(current.extras!.calorie_estimator_nutrition_status).toBe("partial-withheld")
    expect(JSON.parse(current.extras!.calorie_estimator_unmatched_details)[0]).toMatchObject({ name: "Garam Masala", grams: null, reason: "unknown weight" })
    expect(estimateGrams).not.toHaveBeenCalled()
    expect(lookupNutrients).not.toHaveBeenCalled()
    expect(estimateNutrients).not.toHaveBeenCalled()
    await webhook()
    expect(patchRecipe).toHaveBeenCalledOnce()
  })
})
