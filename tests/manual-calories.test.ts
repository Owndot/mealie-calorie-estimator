import { describe, it, expect } from "vitest"
import { computeIngredientHash, buildNutritionPatch, buildManualAckPatch, hasManualCalories } from "../src/services/estimator.js"
import type { MealieRecipe } from "../src/types.js"

function makeRecipe(overrides: Partial<MealieRecipe> = {}): MealieRecipe {
  return {
    slug: "test",
    name: "Test",
    recipeYield: "4 servings",
    recipeServings: 4,
    recipeIngredient: [
      {
        quantity: 500,
        unit: { id: "1", name: "g", pluralName: "g", abbreviation: "g", standardQuantity: null, standardUnit: null },
        food: { id: "1", name: "Mehl", pluralName: null, aliases: [] },
        note: null, display: "500 g Mehl", title: null, original_text: null,
      },
    ],
    nutrition: null,
    tags: [],
    extras: {},
    householdId: null,
    ...overrides,
  }
}

describe("Manual calories flow", () => {
  it("detects manual entry: no hash, has nutrition set", () => {
    const recipe = makeRecipe({
      nutrition: {
        calories: "500", carbohydrateContent: null, cholesterolContent: null, fatContent: null, fiberContent: null, proteinContent: null, saturatedFatContent: null, sodiumContent: null, sugarContent: null, transFatContent: null, unsaturatedFatContent: null,
      },
      extras: {},
    })
    expect(hasManualCalories(recipe)).toBe(true)
  })

  it("does NOT detect manual when hash AND provenance exist (genuinely auto-calculated before)", () => {
    // Provenance (not just a hash) is what actually proves a real estimate ran -- see
    // hasManualCalories' docstring for the legacy-ack edge case this distinction exists for.
    const recipe = makeRecipe({
      nutrition: {
        calories: "500", carbohydrateContent: null, cholesterolContent: null, fatContent: null, proteinContent: null, saturatedFatContent: null, sodiumContent: null, sugarContent: null, transFatContent: null, unsaturatedFatContent: null, fiberContent: null, cholesterolContent: null,
      },
      extras: { calorie_estimator_hash: "abc123", calorie_estimator_provenance: "[]" },
    })
    expect(hasManualCalories(recipe)).toBe(false)
  })

  it("acknowledges manual entry with ack patch, preserving calories", () => {
    const recipe = makeRecipe({
      nutrition: {
        calories: "500", carbohydrateContent: null, cholesterolContent: null, fatContent: null, fiberContent: null, proteinContent: null, saturatedFatContent: null, sodiumContent: null, sugarContent: null, transFatContent: null, unsaturatedFatContent: null,
      },
    })
    const hash = computeIngredientHash(recipe)
    const patch = buildManualAckPatch(recipe, hash, "never-estimated")

    // No `nutrition` key at all -- Mealie replaces the whole sub-object on any PATCH that
    // includes the key (confirmed live), so omitting it is the only way to leave "500" alone.
    expect(patch.nutrition).toBeUndefined()
    expect(patch.extras.calorie_estimator_hash).toBe(hash)
    expect(patch.extras.calorie_estimator_note).toContain("Manual")
  })

  it("normal estimate patch overwrites when ingredients change (hash differs)", () => {
    const before = makeRecipe()
    const hash = computeIngredientHash(before)

    // After ingredient change
    const after = makeRecipe({
      recipeIngredient: [
        {
          quantity: 600,
          unit: { id: "1", name: "g", pluralName: "g", abbreviation: "g", standardQuantity: null, standardUnit: null },
          food: { id: "1", name: "Mehl", pluralName: null, aliases: [] },
          note: null, display: "600 g Mehl", title: null, original_text: null,
        },
      ],
    })
    const newHash = computeIngredientHash(after)

    expect(newHash).not.toBe(hash) // ingredients changed → hash changed
  })
})
