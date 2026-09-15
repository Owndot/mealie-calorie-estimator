import { describe, it, expect } from "vitest"
import { computeNutritionFingerprint, perServingFromRecipeNutrition } from "../src/services/nutrition-format.js"
import type { MealieNutrition } from "../src/types.js"

function mn(overrides: Partial<MealieNutrition> = {}): MealieNutrition {
  return {
    calories: "350", proteinContent: "10", carbohydrateContent: "40", fatContent: "15",
    saturatedFatContent: null, transFatContent: null, unsaturatedFatContent: null,
    fiberContent: null, sugarContent: null, sodiumContent: null, cholesterolContent: null,
    ...overrides,
  }
}

describe("computeNutritionFingerprint", () => {
  it("is deterministic for identical inputs", () => {
    expect(computeNutritionFingerprint(mn())).toBe(computeNutritionFingerprint(mn()))
  })

  it("differs when any field differs", () => {
    expect(computeNutritionFingerprint(mn())).not.toBe(computeNutritionFingerprint(mn({ calories: "351" })))
    expect(computeNutritionFingerprint(mn())).not.toBe(computeNutritionFingerprint(mn({ sodiumContent: "500" })))
  })

  it("treats the all-null (withheld) state as its own stable fingerprint", () => {
    const empty: MealieNutrition = {
      calories: null, proteinContent: null, carbohydrateContent: null, fatContent: null,
      saturatedFatContent: null, transFatContent: null, unsaturatedFatContent: null,
      fiberContent: null, sugarContent: null, sodiumContent: null, cholesterolContent: null,
    }
    expect(computeNutritionFingerprint(empty)).toBe(computeNutritionFingerprint(empty))
    expect(computeNutritionFingerprint(empty)).not.toBe(computeNutritionFingerprint(mn()))
  })

  it("treats a missing key the same as an explicit null (withheld patches omit fields entirely)", () => {
    expect(computeNutritionFingerprint({})).toBe(computeNutritionFingerprint({ calories: null }))
  })

  it("is not fooled by rounding: an unrounded internal value and its milligram-rounded Mealie string are DIFFERENT strings on purpose", () => {
    // This is exactly the case that broke the old NutrientSet-based fingerprint: sodium
    // 1.6g/3 servings = 0.5333...g internally, but written to Mealie as "533" mg. Fingerprinting
    // the actual written string (not the unrounded float) means write and read always agree.
    const written = mn({ sodiumContent: "533" })
    const fp = computeNutritionFingerprint(written)
    const readBack = mn({ sodiumContent: "533" })
    expect(computeNutritionFingerprint(readBack)).toBe(fp)
  })
})

describe("perServingFromRecipeNutrition", () => {
  it("converts sodium/cholesterol from Mealie's milligrams to internal grams", () => {
    const result = perServingFromRecipeNutrition(mn({ sodiumContent: "800", cholesterolContent: "100" }))
    expect(result.sodiumPer100g).toBe(0.8)
    expect(result.cholesterolPer100g).toBe(0.1)
  })
})
