import { describe, it, expect, vi, beforeEach } from "vitest"
import type { MealieRecipe, MealieRecipePatch } from "../src/types.js"

const patchCalls: { slug: string; patch: MealieRecipePatch }[] = []
let mockRecipe: MealieRecipe

vi.mock("../src/services/mealie-client.js", () => ({
  getRecipe: vi.fn(async () => mockRecipe),
  getRecipeHouseholdId: vi.fn(() => null),
  patchRecipe: vi.fn(async (slug: string, patch: MealieRecipePatch) => {
    patchCalls.push({ slug, patch })
  }),
  getOrCreateTags: vi.fn(async (names: string[]) =>
    names.map((name) => ({ id: name, name, slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), groupId: null })),
  ),
}))

function baseRecipe(overrides: Partial<MealieRecipe> = {}): MealieRecipe {
  return {
    slug: "test-recipe",
    name: "Test",
    recipeYield: null,
    recipeServings: 4,
    recipeIngredient: [
      {
        quantity: 100,
        unit: { id: "g", name: "g", pluralName: "g", abbreviation: "g", standardQuantity: null, standardUnit: null },
        food: { id: "1", name: "Mehl", pluralName: null, aliases: [] },
        note: null, display: "", title: null, originalText: null,
      },
    ],
    nutrition: null,
    tags: [],
    extras: {},
    householdId: null,
    ...overrides,
  }
}

describe("runEstimationPipeline", () => {
  beforeEach(() => {
    patchCalls.length = 0
    vi.resetModules()
  })

  it("skips recipes not tagged for estimation under the 'tagged' strategy", async () => {
    process.env.ESTIMATE_STRATEGY = "tagged"
    mockRecipe = baseRecipe({ tags: [] })
    const { runEstimationPipeline } = await import("../src/services/pipeline.js")

    const outcome = await runEstimationPipeline("test-recipe")
    expect(outcome.status).toBe("skipped-not-tagged")
    expect(patchCalls).toHaveLength(0)
    delete process.env.ESTIMATE_STRATEGY
  })

  it("estimates a fresh recipe (no prior hash) and writes nutrition + hash", async () => {
    mockRecipe = baseRecipe()
    const { runEstimationPipeline } = await import("../src/services/pipeline.js")

    const outcome = await runEstimationPipeline("test-recipe")
    expect(outcome.status).toBe("estimated")
    expect(patchCalls).toHaveLength(1)
    expect(patchCalls[0].patch.extras?.calorie_estimator_hash).toBeTruthy()
  })

  it("webhook-triggered re-processing settles to a no-op on the second pass (loop prevention)", async () => {
    mockRecipe = baseRecipe()
    const { runEstimationPipeline, } = await import("../src/services/pipeline.js")
    const { computeIngredientHash } = await import("../src/services/estimator.js")

    const first = await runEstimationPipeline("test-recipe")
    expect(first.status).toBe("estimated")

    // Simulate Mealie now reflecting the patch that was just written (hash + auto-tags applied),
    // exactly as a second "Recipe Updated" webhook fired by that PATCH would see.
    const appliedPatch = patchCalls[0].patch
    mockRecipe = {
      ...mockRecipe,
      nutrition: { ...mockRecipe.nutrition, ...appliedPatch.nutrition } as MealieRecipe["nutrition"],
      extras: { ...mockRecipe.extras, ...appliedPatch.extras },
      tags: appliedPatch.tags ?? mockRecipe.tags,
    }
    expect(mockRecipe.extras?.calorie_estimator_hash).toBe(computeIngredientHash(mockRecipe))

    patchCalls.length = 0
    const second = await runEstimationPipeline("test-recipe")
    expect(second.status).toBe("no-op")
    expect(patchCalls).toHaveLength(0)
  })

  it("preserves manual nutrition (no hash, has nutrition) without overwriting it", async () => {
    mockRecipe = baseRecipe({
      nutrition: { calories: "500", carbohydrateContent: null, cholesterolContent: null, fatContent: null, fiberContent: null, proteinContent: null, saturatedFatContent: null, sodiumContent: null, sugarContent: null, transFatContent: null, unsaturatedFatContent: null },
      extras: {},
    })
    const { runEstimationPipeline } = await import("../src/services/pipeline.js")

    const outcome = await runEstimationPipeline("test-recipe")
    expect(outcome.status).toBe("manual-preserved")
    expect(patchCalls[0].patch.nutrition).toEqual({})
  })

  describe("force / overrideManual (does not bypass manual protection unless explicit)", () => {
    it("force=true re-estimates even when the ingredient hash is unchanged", async () => {
      mockRecipe = baseRecipe()
      const { runEstimationPipeline } = await import("../src/services/pipeline.js")
      const { computeIngredientHash } = await import("../src/services/estimator.js")

      mockRecipe = {
        ...mockRecipe,
        tags: [{ id: "digest-unknown", name: "Digest:Unknown", slug: "digest-unknown", groupId: null }],
        extras: { calorie_estimator_hash: computeIngredientHash(mockRecipe), calorie_estimator_tags: JSON.stringify(["digest-unknown"]) },
      }

      // Without force this would be a no-op (hash unchanged, tags already complete) — confirm that first.
      const withoutForce = await runEstimationPipeline("test-recipe")
      expect(withoutForce.status).toBe("no-op")

      // force must bypass the hash-unchanged skip and re-estimate anyway.
      const outcome = await runEstimationPipeline("test-recipe", { force: true })
      expect(outcome.status).toBe("estimated")
    })

    it("force=true alone does NOT overwrite genuinely manual nutrition", async () => {
      mockRecipe = baseRecipe({
        nutrition: { calories: "500", carbohydrateContent: null, cholesterolContent: null, fatContent: null, fiberContent: null, proteinContent: null, saturatedFatContent: null, sodiumContent: null, sugarContent: null, transFatContent: null, unsaturatedFatContent: null },
        extras: {},
      })
      const { runEstimationPipeline } = await import("../src/services/pipeline.js")

      const outcome = await runEstimationPipeline("test-recipe", { force: true })
      expect(outcome.status).toBe("manual-preserved")
      expect(patchCalls[0].patch.nutrition).toEqual({})
    })

    it("overrideManual=true (with force) does overwrite manual nutrition — the distinct, explicit path", async () => {
      mockRecipe = baseRecipe({
        nutrition: { calories: "500", carbohydrateContent: null, cholesterolContent: null, fatContent: null, fiberContent: null, proteinContent: null, saturatedFatContent: null, sodiumContent: null, sugarContent: null, transFatContent: null, unsaturatedFatContent: null },
        extras: {},
      })
      const { runEstimationPipeline } = await import("../src/services/pipeline.js")

      const outcome = await runEstimationPipeline("test-recipe", { force: true, overrideManual: true })
      expect(outcome.status).toBe("estimated")
      expect(patchCalls[0].patch.nutrition?.calories).toBeDefined()
    })
  })
})
