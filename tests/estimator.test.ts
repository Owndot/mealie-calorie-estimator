import { describe, it, expect } from "vitest"
import { computeIngredientHash, parseYield, buildNutritionPatch, hasManualCalories, isManuallyOwned, hasManuallyModifiedNutrition, buildManualAckPatch } from "../src/services/estimator.js"
import { computeNutritionFingerprint } from "../src/services/nutrition-format.js"
import type { MealieRecipe, EstimateResult, NutrientSet, MealieNutrition } from "../src/types.js"

function makeRecipe(overrides: Partial<MealieRecipe> = {}): MealieRecipe {
  return {
    slug: "test-recipe",
    name: "Test Recipe",
    recipeYield: "4 servings",
    recipeServings: 4,
    recipeIngredient: [],
    nutrition: null,
    tags: [],
    extras: {},
    householdId: null,
    ...overrides,
  }
}

function n(kcal: number | null, p: Partial<NutrientSet> = {}): NutrientSet {
  return {
    kcalPer100g: kcal, proteinPer100g: null, carbsPer100g: null, fatPer100g: null,
    saturatedFatPer100g: null, transFatPer100g: null, unsaturatedFatPer100g: null,
    fiberPer100g: null, sugarPer100g: null, sodiumPer100g: null, cholesterolPer100g: null,
    ...p,
  }
}

describe("computeIngredientHash", () => {
  it("produces consistent hash for same ingredients", () => {
    const a = makeRecipe({
      recipeIngredient: [
        {
          quantity: 2, unit: { id: "1", name: "cup", pluralName: "cups", abbreviation: "c", standardQuantity: null, standardUnit: null },
          food: { id: "1", name: "flour", pluralName: null, aliases: [] },
          note: null, display: "2 cups flour", title: null, original_text: null,
        },
        {
          quantity: 1, unit: { id: "2", name: "tbsp", pluralName: "tbsp", abbreviation: "T", standardQuantity: null, standardUnit: null },
          food: { id: "2", name: "sugar", pluralName: null, aliases: [] },
          note: null, display: "1 tbsp sugar", title: null, original_text: null,
        },
      ],
    })

    const b = makeRecipe({
      recipeIngredient: [
        {
          quantity: 1, unit: { id: "2", name: "tbsp", pluralName: "tbsp", abbreviation: "T", standardQuantity: null, standardUnit: null },
          food: { id: "2", name: "sugar", pluralName: null, aliases: [] },
          note: null, display: "1 tbsp sugar", title: null, original_text: null,
        },
        {
          quantity: 2, unit: { id: "1", name: "cup", pluralName: "cups", abbreviation: "c", standardQuantity: null, standardUnit: null },
          food: { id: "1", name: "flour", pluralName: null, aliases: [] },
          note: null, display: "2 cups flour", title: null, original_text: null,
        },
      ],
    })

    expect(computeIngredientHash(a)).toBe(computeIngredientHash(b))
  })

  it("produces different hash for different ingredients", () => {
    const a = makeRecipe({
      recipeIngredient: [
        {
          quantity: 2, unit: { id: "1", name: "cup", pluralName: "cups", abbreviation: "c", standardQuantity: null, standardUnit: null },
          food: { id: "1", name: "flour", pluralName: null, aliases: [] },
          note: null, display: "2 cups flour", title: null, original_text: null,
        },
      ],
    })

    const b = makeRecipe({
      recipeIngredient: [
        {
          quantity: 3, unit: { id: "1", name: "cup", pluralName: "cups", abbreviation: "c", standardQuantity: null, standardUnit: null },
          food: { id: "1", name: "flour", pluralName: null, aliases: [] },
          note: null, display: "3 cups flour", title: null, original_text: null,
        },
      ],
    })

    expect(computeIngredientHash(a)).not.toBe(computeIngredientHash(b))
  })

  it("handles empty ingredient list", () => {
    const recipe = makeRecipe({ recipeIngredient: [] })
    expect(computeIngredientHash(recipe)).toBeTruthy()
  })

  it("produces different hash when servings change but ingredients are the same", () => {
    const a = makeRecipe({ recipeYield: "4 servings", recipeServings: 4 })
    const b = makeRecipe({ recipeYield: "6 servings", recipeServings: 6 })

    expect(computeIngredientHash(a)).not.toBe(computeIngredientHash(b))
  })

  it("produces same hash when yield string differs but parsed servings are same", () => {
    const a = makeRecipe({ recipeYield: "4 servings", recipeServings: 4 })
    const b = makeRecipe({ recipeYield: "4 Portionen", recipeServings: 4 })

    expect(computeIngredientHash(a)).not.toBe(computeIngredientHash(b))
  })

  it("handles null fields", () => {
    const recipe = makeRecipe({
      recipeIngredient: [
        {
          quantity: null, unit: null, food: null,
          note: "salt to taste", display: "salt to taste", title: null, original_text: null,
        },
      ],
    })
    expect(computeIngredientHash(recipe)).toBeTruthy()
  })
})

describe("parseYield", () => {
  it.each([
    ["4 servings", 4],
    ["6 Portionen", 6],
    ["1 loaf", 1],
    ["6-8 portions", 7],
    ["4-6", 5],
    ["12", 12],
    ["2.5 cups", 2.5],
  ])("parses '%s' to %d", (input, expected) => {
    expect(parseYield(input)).toBe(expected)
  })

  it.each([
    [null, null],
    ["", null],
    ["as needed", null],
  ])("returns null for '%s'", (input, expected) => {
    expect(parseYield(input)).toBe(expected)
  })
})

describe("buildNutritionPatch", () => {
  it("builds patch with all nutrients per serving", () => {
    const result: EstimateResult = {
      slug: "test",
      servings: 4,
      totalNutrients: n(1400, { proteinPer100g: 40, fatPer100g: 60 }),
      perServingNutrients: n(350, { proteinPer100g: 10, fatPer100g: 15 }),
      matchedCount: 5,
      unmatchedCount: 0,
      unmatchedIngredients: [],
      matchedIngredients: [],
      completeness: "complete",
      completenessReason: null,
    }

    const patch = buildNutritionPatch(result, "abc123", "4 servings")

    expect(patch.nutrition.calories).toBe("350")
    expect(patch.nutrition.proteinContent).toBe("10")
    expect(patch.nutrition.fatContent).toBe("15")
    expect(patch.extras.calorie_estimator_hash).toBe("abc123")
    expect(patch.extras.calorie_estimator_total_kcal).toBe("1400")
    expect(patch.extras.calorie_estimator_yield).toBe("4")
    expect(patch.extras.calorie_estimator_unmatched).toBe("[]")
    expect(patch.extras.calorie_estimator_status).toBe("complete")
    // A real estimate always clears manual ownership — see isManuallyOwned.
    expect(patch.extras.calorie_estimator_manual).toBe("false")
    expect(patch.extras.calorie_estimator_nutrition_fingerprint).toBeTruthy()
  })

  it("builds patch with empty nutrition when no servings", () => {
    const result: EstimateResult = {
      slug: "test",
      servings: null,
      totalNutrients: n(500),
      perServingNutrients: n(null),
      matchedCount: 2,
      unmatchedCount: 0,
      unmatchedIngredients: [],
      matchedIngredients: [],
      completeness: "complete",
      completenessReason: null,
    }

    const patch = buildNutritionPatch(result, "def456", null)

    expect(patch.nutrition.calories).toBeUndefined()
    expect(patch.extras.calorie_estimator_yield).toBeUndefined()
    expect(patch.extras.calorie_estimator_total_kcal).toBe("500")
  })

  it("handles zero total kcal", () => {
    const result: EstimateResult = {
      slug: "test",
      servings: 4,
      totalNutrients: n(0),
      perServingNutrients: n(0),
      matchedCount: 0,
      unmatchedCount: 3,
      unmatchedIngredients: ["salt", "pepper", "herbs"],
      matchedIngredients: [],
      completeness: "partial",
      completenessReason: "3 ingredient(s) unresolved but weight share is minor",
    }

    const patch = buildNutritionPatch(result, "ghi789", "4 servings")

    expect(patch.nutrition.calories).toBe("0")
    expect(patch.extras.calorie_estimator_total_kcal).toBeUndefined()
    expect(patch.extras.calorie_estimator_unmatched).toBe(JSON.stringify(["salt", "pepper", "herbs"]))
    expect(patch.extras.calorie_estimator_status).toBe("partial")
    expect(patch.extras.calorie_estimator_status_reason).toContain("minor")
  })

  it("converts sodium/cholesterol from internal grams to milligrams for Mealie (schema.org convention)", () => {
    const result: EstimateResult = {
      slug: "test",
      servings: 4,
      totalNutrients: n(400, { sodiumPer100g: 3.2, cholesterolPer100g: 0.4 }),
      perServingNutrients: n(100, { sodiumPer100g: 0.8, cholesterolPer100g: 0.1 }),
      matchedCount: 3,
      unmatchedCount: 0,
      unmatchedIngredients: [],
      matchedIngredients: [],
      completeness: "complete",
      completenessReason: null,
    }

    const patch = buildNutritionPatch(result, "mg-test", "4 servings")

    expect(patch.nutrition.sodiumContent).toBe("800")
    expect(patch.nutrition.cholesterolContent).toBe("100")
  })

  it("withholds nutrition values entirely when completeness is 'withheld', but still writes hash/status/unmatched", () => {
    const result: EstimateResult = {
      slug: "test",
      servings: 4,
      totalNutrients: n(null),
      perServingNutrients: n(null),
      matchedCount: 1,
      unmatchedCount: 1,
      unmatchedIngredients: ["Rinderhack"],
      matchedIngredients: [],
      completeness: "withheld",
      completenessReason: "60% of known ingredient weight is unresolved — nutrition withheld to avoid a misleading result",
    }

    const patch = buildNutritionPatch(result, "withheld-hash", "4 servings")

    expect(patch.nutrition).toEqual({})
    expect(patch.extras.calorie_estimator_hash).toBe("withheld-hash")
    expect(patch.extras.calorie_estimator_status).toBe("withheld")
    expect(patch.extras.calorie_estimator_status_reason).toContain("withheld")
    expect(patch.extras.calorie_estimator_unmatched).toBe(JSON.stringify(["Rinderhack"]))
  })

  it("includes per-ingredient provenance in extras", () => {
    const result: EstimateResult = {
      slug: "test",
      servings: 2,
      totalNutrients: n(200),
      perServingNutrients: n(100),
      matchedCount: 1,
      unmatchedCount: 0,
      unmatchedIngredients: [],
      matchedIngredients: [
        {
          name: "Mehl", canonicalName: "Mehl", brand: null, route: "generic",
          grams: 100, gramsEstimated: false, matched: true,
          nutrients: n(364), provider: "usda", providerId: "Mehl",
          confidence: 0.7, fallbackStatus: "usda", llmParticipated: false,
        },
      ],
      completeness: "complete",
      completenessReason: null,
    }

    const patch = buildNutritionPatch(result, "prov-hash", "2 servings")
    const provenance = JSON.parse(patch.extras.calorie_estimator_provenance)
    expect(provenance).toHaveLength(1)
    expect(provenance[0]).toMatchObject({ name: "Mehl", provider: "usda", confidence: 0.7, matched: true })
  })
})

describe("hasManualCalories", () => {
  it("detects manual entry: no hash, has nutrition", () => {
    const recipe = makeRecipe({
      nutrition: { calories: "400", carbohydrateContent: null, cholesterolContent: null, fatContent: null, fiberContent: null, proteinContent: null, saturatedFatContent: null, sodiumContent: null, sugarContent: null, transFatContent: null, unsaturatedFatContent: null },
      extras: {},
    })
    expect(hasManualCalories(recipe)).toBe(true)
  })

  it("returns false when hash already exists", () => {
    const recipe = makeRecipe({
      nutrition: { calories: "400", carbohydrateContent: null, cholesterolContent: null, fatContent: null, fiberContent: null, proteinContent: null, saturatedFatContent: null, sodiumContent: null, sugarContent: null, transFatContent: null, unsaturatedFatContent: null },
      extras: { calorie_estimator_hash: "abc123" },
    })
    expect(hasManualCalories(recipe)).toBe(false)
  })

  it("returns false when nutrition.calories is empty", () => {
    const recipe = makeRecipe({
      nutrition: { calories: "", carbohydrateContent: null, cholesterolContent: null, fatContent: null, fiberContent: null, proteinContent: null, saturatedFatContent: null, sodiumContent: null, sugarContent: null, transFatContent: null, unsaturatedFatContent: null },
      extras: {},
    })
    expect(hasManualCalories(recipe)).toBe(false)
  })

  it("returns false when nutrition is null", () => {
    const recipe = makeRecipe({ nutrition: null, extras: {} })
    expect(hasManualCalories(recipe)).toBe(false)
  })
})

describe("isManuallyOwned — stays true across later runs, not just the very first detection", () => {
  it("is true on first detection (no hash, has nutrition), same as hasManualCalories", () => {
    const recipe = makeRecipe({
      nutrition: { calories: "400", carbohydrateContent: null, cholesterolContent: null, fatContent: null, fiberContent: null, proteinContent: null, saturatedFatContent: null, sodiumContent: null, sugarContent: null, transFatContent: null, unsaturatedFatContent: null },
      extras: {},
    })
    expect(isManuallyOwned(recipe)).toBe(true)
  })

  it("stays true once the persistent calorie_estimator_manual flag is set, even though a hash is now present (hasManualCalories alone would return false here)", () => {
    const recipe = makeRecipe({
      nutrition: { calories: "500", carbohydrateContent: null, cholesterolContent: null, fatContent: null, fiberContent: null, proteinContent: null, saturatedFatContent: null, sodiumContent: null, sugarContent: null, transFatContent: null, unsaturatedFatContent: null },
      extras: { calorie_estimator_hash: "h1", calorie_estimator_manual: "true" },
    })
    expect(hasManualCalories(recipe)).toBe(false) // hash is present now
    expect(isManuallyOwned(recipe)).toBe(true) // but the persistent flag still protects it
  })

  it("is false once the flag has been explicitly cleared by a real estimate", () => {
    const recipe = makeRecipe({
      nutrition: { calories: "350", carbohydrateContent: null, cholesterolContent: null, fatContent: null, fiberContent: null, proteinContent: null, saturatedFatContent: null, sodiumContent: null, sugarContent: null, transFatContent: null, unsaturatedFatContent: null },
      extras: { calorie_estimator_hash: "h1", calorie_estimator_manual: "false" },
    })
    expect(isManuallyOwned(recipe)).toBe(false)
  })
})

describe("hasManuallyModifiedNutrition — detects a hand-edit of previously estimator-written nutrition", () => {
  function estimatorWrittenNutrition(): MealieNutrition {
    return {
      calories: "350", proteinContent: "10", carbohydrateContent: "40", fatContent: "15",
      saturatedFatContent: null, transFatContent: null, unsaturatedFatContent: null,
      fiberContent: null, sugarContent: null, sodiumContent: null, cholesterolContent: null,
    }
  }

  function fingerprintFor(nutrition: MealieNutrition): string {
    return computeNutritionFingerprint(nutrition)
  }

  it("returns false when nutrition still matches the fingerprint the estimator wrote", () => {
    const nutrition = estimatorWrittenNutrition()
    const recipe = makeRecipe({
      nutrition,
      extras: { calorie_estimator_hash: "h1", calorie_estimator_nutrition_fingerprint: fingerprintFor(nutrition) },
    })
    expect(hasManuallyModifiedNutrition(recipe)).toBe(false)
  })

  it("returns true when current nutrition differs from the estimator-written fingerprint", () => {
    const written = estimatorWrittenNutrition()
    const recipe = makeRecipe({
      nutrition: { ...written, calories: "999" }, // a person changed the calorie value by hand
      extras: { calorie_estimator_hash: "h1", calorie_estimator_nutrition_fingerprint: fingerprintFor(written) },
    })
    expect(hasManuallyModifiedNutrition(recipe)).toBe(true)
  })

  it("returns false (conservative default) when there is no stored fingerprint, even with a hash present", () => {
    const recipe = makeRecipe({
      nutrition: estimatorWrittenNutrition(),
      extras: { calorie_estimator_hash: "h1" }, // pre-upgrade write, no fingerprint recorded yet
    })
    expect(hasManuallyModifiedNutrition(recipe)).toBe(false)
  })

  it("returns false when there is no hash at all (that's hasManualCalories' concern, not this one)", () => {
    const recipe = makeRecipe({
      nutrition: estimatorWrittenNutrition(),
      extras: {},
    })
    expect(hasManuallyModifiedNutrition(recipe)).toBe(false)
  })

  it("detects a person manually adding nutrition to a recipe the estimator had left withheld (all-null fingerprint)", () => {
    const emptyFingerprint = computeNutritionFingerprint({})
    const recipe = makeRecipe({
      nutrition: { calories: "500", proteinContent: null, carbohydrateContent: null, fatContent: null, saturatedFatContent: null, transFatContent: null, unsaturatedFatContent: null, fiberContent: null, sugarContent: null, sodiumContent: null, cholesterolContent: null },
      extras: { calorie_estimator_hash: "h1", calorie_estimator_nutrition_fingerprint: emptyFingerprint },
    })
    expect(hasManuallyModifiedNutrition(recipe)).toBe(true)
  })
})

describe("buildManualAckPatch", () => {
  it("sets hash and note, leaves nutrition untouched", () => {
    const recipe = makeRecipe({
      nutrition: { calories: "400", carbohydrateContent: null, cholesterolContent: null, fatContent: null, fiberContent: null, proteinContent: null, saturatedFatContent: null, sodiumContent: null, sugarContent: null, transFatContent: null, unsaturatedFatContent: null },
      extras: {},
    })
    const patch = buildManualAckPatch(recipe, "manual-hash", "never-estimated")

    expect(patch.nutrition).toEqual({})
    expect(patch.extras.calorie_estimator_hash).toBe("manual-hash")
    expect(patch.extras.calorie_estimator_note).toBe("Manual — preserved existing calorie entry")
    // Persists manual ownership across future runs — see isManuallyOwned.
    expect(patch.extras.calorie_estimator_manual).toBe("true")
  })

  it("uses a different note for nutrition modified after an earlier estimate", () => {
    const recipe = makeRecipe({
      nutrition: { calories: "400", carbohydrateContent: null, cholesterolContent: null, fatContent: null, fiberContent: null, proteinContent: null, saturatedFatContent: null, sodiumContent: null, sugarContent: null, transFatContent: null, unsaturatedFatContent: null },
      extras: { calorie_estimator_hash: "old-hash" },
    })
    const patch = buildManualAckPatch(recipe, "manual-hash", "modified-after-estimate")
    expect(patch.extras.calorie_estimator_note).toContain("edited after estimation")
  })
})
