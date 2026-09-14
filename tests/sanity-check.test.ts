import { describe, it, expect } from "vitest"
import { sanityCheckNutrients } from "../src/services/sanity-check.js"
import type { NutrientSet } from "../src/types.js"

function n(overrides: Partial<NutrientSet> = {}): NutrientSet {
  return {
    kcalPer100g: null, proteinPer100g: null, carbsPer100g: null, fatPer100g: null,
    saturatedFatPer100g: null, transFatPer100g: null, unsaturatedFatPer100g: null,
    fiberPer100g: null, sugarPer100g: null, sodiumPer100g: null, cholesterolPer100g: null,
    ...overrides,
  }
}

describe("sanityCheckNutrients", () => {
  it("accepts a plausible nutrient set", () => {
    const result = sanityCheckNutrients(n({ kcalPer100g: 364, proteinPer100g: 10, carbsPer100g: 76, fatPer100g: 1 }), "Mehl")
    expect(result.ok).toBe(true)
  })

  it("rejects negative values", () => {
    const result = sanityCheckNutrients(n({ kcalPer100g: -50 }), "Mehl")
    expect(result.ok).toBe(false)
  })

  it("rejects implausible kcal/100g above the pure-fat ceiling", () => {
    const result = sanityCheckNutrients(n({ kcalPer100g: 5000 }), "Zucker")
    expect(result.ok).toBe(false)
  })

  it("rejects kcal inconsistent with macros (Atwater factor check)", () => {
    // 10g protein + 10g carbs + 10g fat should be ~170 kcal, not 900
    const result = sanityCheckNutrients(n({ kcalPer100g: 900, proteinPer100g: 10, carbsPer100g: 10, fatPer100g: 10 }), "Mystery Food")
    expect(result.ok).toBe(false)
  })

  it("accepts kcal within tolerance of macros", () => {
    const result = sanityCheckNutrients(n({ kcalPer100g: 165, proteinPer100g: 31, carbsPer100g: 0, fatPer100g: 3.6 }), "Hähnchenbrust")
    expect(result.ok).toBe(true)
  })

  it("skips the macro consistency check when a macro is unknown", () => {
    const result = sanityCheckNutrients(n({ kcalPer100g: 500, proteinPer100g: null, carbsPer100g: 10, fatPer100g: 10 }), "Unknown Food")
    expect(result.ok).toBe(true)
  })

  describe("salt/sodium unit-scale bug detection", () => {
    it("rejects a salt-labeled ingredient with near-zero sodium (classic g/mg scale bug)", () => {
      // e.g. 30g of salt should carry ~11.4g sodium; a value like 0.012 (12mg-as-if-grams) is the bug
      const result = sanityCheckNutrients(n({ kcalPer100g: 0, sodiumPer100g: 0.012 }), "Salz")
      expect(result.ok).toBe(false)
    })

    it("accepts a salt-labeled ingredient with plausible sodium (~38-39g/100g)", () => {
      const result = sanityCheckNutrients(n({ kcalPer100g: 0, sodiumPer100g: 38.75 }), "Meersalz")
      expect(result.ok).toBe(true)
    })

    it("rejects a salt-labeled ingredient carrying meaningful calories", () => {
      const result = sanityCheckNutrients(n({ kcalPer100g: 300, sodiumPer100g: 38 }), "Salz")
      expect(result.ok).toBe(false)
    })

    it("does not apply the salt rule to unrelated foods", () => {
      const result = sanityCheckNutrients(n({ kcalPer100g: 165, proteinPer100g: 31, carbsPer100g: 0, fatPer100g: 3.6, sodiumPer100g: 0.074 }), "Hähnchenbrust")
      expect(result.ok).toBe(true)
    })
  })

  it("rejects saturated fat exceeding total fat", () => {
    const result = sanityCheckNutrients(n({ fatPer100g: 5, saturatedFatPer100g: 20 }), "Butter")
    expect(result.ok).toBe(false)
  })

  it("rejects sugar exceeding total carbs", () => {
    const result = sanityCheckNutrients(n({ carbsPer100g: 5, sugarPer100g: 50 }), "Zucker")
    expect(result.ok).toBe(false)
  })
})
