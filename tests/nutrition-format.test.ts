import { describe, it, expect } from "vitest"
import { computeNutritionFingerprint, perServingFromRecipeNutrition } from "../src/services/nutrition-format.js"
import type { NutrientSet } from "../src/types.js"

function n(overrides: Partial<NutrientSet> = {}): NutrientSet {
  return {
    kcalPer100g: 350, proteinPer100g: 10, carbsPer100g: 40, fatPer100g: 15,
    saturatedFatPer100g: null, transFatPer100g: null, unsaturatedFatPer100g: null,
    fiberPer100g: null, sugarPer100g: null, sodiumPer100g: null, cholesterolPer100g: null,
    ...overrides,
  }
}

describe("computeNutritionFingerprint", () => {
  it("is deterministic for identical inputs", () => {
    expect(computeNutritionFingerprint(n())).toBe(computeNutritionFingerprint(n()))
  })

  it("differs when any field differs", () => {
    expect(computeNutritionFingerprint(n())).not.toBe(computeNutritionFingerprint(n({ kcalPer100g: 351 })))
    expect(computeNutritionFingerprint(n())).not.toBe(computeNutritionFingerprint(n({ sodiumPer100g: 0.5 })))
  })

  it("treats the all-null (withheld) state as its own stable fingerprint", () => {
    const empty: NutrientSet = {
      kcalPer100g: null, proteinPer100g: null, carbsPer100g: null, fatPer100g: null,
      saturatedFatPer100g: null, transFatPer100g: null, unsaturatedFatPer100g: null,
      fiberPer100g: null, sugarPer100g: null, sodiumPer100g: null, cholesterolPer100g: null,
    }
    expect(computeNutritionFingerprint(empty)).toBe(computeNutritionFingerprint(empty))
    expect(computeNutritionFingerprint(empty)).not.toBe(computeNutritionFingerprint(n()))
  })
})

describe("perServingFromRecipeNutrition round-trips with computeNutritionFingerprint", () => {
  it("a fingerprint computed at write time matches one recomputed from the parsed-back Mealie strings", () => {
    const written = n({ sodiumPer100g: 0.8, cholesterolPer100g: 0.1 })
    const writeFingerprint = computeNutritionFingerprint(written)

    // Simulate what buildNutritionPatch actually writes to Mealie (sodium/cholesterol in mg)
    // and what a later fetch would read back.
    const mealieNutrition = {
      calories: "350", proteinContent: "10", carbohydrateContent: "40", fatContent: "15",
      saturatedFatContent: null, transFatContent: null, unsaturatedFatContent: null,
      fiberContent: null, sugarContent: null,
      sodiumContent: "800", cholesterolContent: "100",
    }

    const readBack = perServingFromRecipeNutrition(mealieNutrition)
    expect(computeNutritionFingerprint(readBack)).toBe(writeFingerprint)
  })
})
