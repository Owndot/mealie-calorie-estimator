import { describe, expect, it } from "vitest"
import { validateProfile } from "../src/services/nutrition-validation.js"
import type { NutrientSet } from "../src/types.js"
const valid: NutrientSet = {
  kcalPer100g: 100, proteinPer100g: 5, carbsPer100g: 20, fatPer100g: 0,
  saturatedFatPer100g: 0, transFatPer100g: 0, unsaturatedFatPer100g: 0,
  fiberPer100g: 5, sugarPer100g: 2, sodiumPer100g: 400, cholesterolPer100g: 0,
}
describe("profile validation", () => {
  it("accepts 400 mg sodium per 100 g", () => expect(validateProfile(valid)).toEqual([]))
  it.each([
    { sodiumPer100g: 400000 }, { cholesterolPer100g: 4000 }, { kcalPer100g: 1000 },
    { proteinPer100g: -1 }, { fatPer100g: Infinity }, { fatPer100g: NaN },
    { saturatedFatPer100g: 10 }, { sugarPer100g: 90 }, { fiberPer100g: 99 },
    { kcalPer100g: 800 }, { proteinPer100g: 100 },
  ])("rejects impossible profile %j", fields => expect(validateProfile({ ...valid, ...fields }).length).toBeGreaterThan(0))
})
