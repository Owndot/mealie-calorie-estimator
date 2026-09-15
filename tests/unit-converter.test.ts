import { describe, it, expect } from "vitest"
import { convertToGrams } from "../src/services/unit-converter.js"
import type { MealieUnit } from "../src/types.js"

function unit(overrides: Partial<MealieUnit> = {}): MealieUnit {
  return {
    id: "1",
    name: "g",
    pluralName: "g",
    abbreviation: "g",
    standardQuantity: null,
    standardUnit: null,
    ...overrides,
  }
}

describe("convertToGrams", () => {
  it("uses standardQuantity with a mass standardUnit (Mealie conversion takes precedence) and marks it not estimated", () => {
    const u = unit({ name: "custom", standardQuantity: 100, standardUnit: "g" })
    const result = convertToGrams(3, u)
    expect(result?.grams).toBe(300)
    expect(result?.estimated).toBe(false)
  })

  it("uses fixed conversion for food-independent MASS units, not estimated", () => {
    expect(convertToGrams(1, unit({ name: "kg" }))).toEqual({ grams: 1000, estimated: false })
    expect(convertToGrams(1, unit({ name: "oz" }))?.grams).toBe(28.35)
    expect(convertToGrams(1, unit({ name: "lb" }))?.grams).toBe(453.592)
    expect(convertToGrams(1, unit({ name: "mg" }))?.grams).toBe(0.001)
  })

  it("returns null for unknown units", () => {
    expect(convertToGrams(1, unit({ name: "handful", abbreviation: "" }))).toBeNull()
  })

  it("returns null when unit is null", () => {
    expect(convertToGrams(1, null)).toBeNull()
  })

  describe("ml/l are volume units, NOT fixed grams — density depends on the food", () => {
    it("returns null without a food name — never silently assumes density = 1", () => {
      expect(convertToGrams(200, unit({ name: "ml", abbreviation: "" }))).toBeNull()
      expect(convertToGrams(1, unit({ name: "l", abbreviation: "" }))).toBeNull()
    })

    it("200 ml water and 200 ml olive oil resolve to different gram weights", () => {
      const water = convertToGrams(200, unit({ name: "ml", abbreviation: "" }), "Wasser")
      const oil = convertToGrams(200, unit({ name: "ml", abbreviation: "" }), "Olivenöl")

      expect(water?.grams).not.toBeNull()
      expect(oil?.grams).not.toBeNull()
      expect(water!.grams).not.toBe(oil!.grams)
      expect(water!.grams).toBeCloseTo(200, 0) // water ≈ 1 g/ml
      expect(oil!.grams).toBeLessThan(water!.grams) // olive oil is less dense than water
      expect(water?.estimated).toBe(true)
      expect(oil?.estimated).toBe(true)
    })

    it("the original quantity is never mutated by the density lookup", () => {
      const quantity = 200
      const waterUnit = unit({ name: "ml", abbreviation: "" })
      convertToGrams(quantity, waterUnit, "Olivenöl")
      expect(quantity).toBe(200)
      expect(waterUnit.name).toBe("ml")
    })

    it("scales linearly with quantity for the same food", () => {
      const single = convertToGrams(1, unit({ name: "ml", abbreviation: "" }), "Olivenöl")!.grams
      const hundred = convertToGrams(100, unit({ name: "ml", abbreviation: "" }), "Olivenöl")!.grams
      expect(hundred).toBeCloseTo(single * 100, 5)
    })

    it("l (liter) converts through the same density path as ml, scaled by 1000", () => {
      const literResult = convertToGrams(1, unit({ name: "l", abbreviation: "" }), "Milch")
      const mlResult = convertToGrams(1000, unit({ name: "ml", abbreviation: "" }), "Milch")
      expect(literResult?.grams).toBeCloseTo(mlResult!.grams, 5)
    })

    it("returns null for an unrecognized food's volume rather than guessing a density — caller must fall through to LLM", () => {
      expect(convertToGrams(200, unit({ name: "ml", abbreviation: "" }), "vollkommen-unbekannte-fluessigkeit-xyz")).toBeNull()
    })

    it("a standardUnit of ml/l (Mealie's own conversion metadata) also requires food density, not a fixed 1:1", () => {
      const cupInMl = unit({ name: "cup", standardQuantity: 240, standardUnit: "ml", abbreviation: "" })
      expect(convertToGrams(2, cupInMl)).toBeNull() // no food name given
      const result = convertToGrams(2, cupInMl, "Wasser")
      expect(result?.grams).toBeCloseTo(480, 0)
      expect(result?.estimated).toBe(true)
    })
  })

  describe("food-dependent units (EL/TL/cup) require a food name and resolve differently per food", () => {
    it("returns null without a food name — no single universal conversion is applied", () => {
      expect(convertToGrams(1, unit({ name: "EL", abbreviation: "" }))).toBeNull()
      expect(convertToGrams(1, unit({ name: "TL", abbreviation: "" }))).toBeNull()
      expect(convertToGrams(1, unit({ name: "cup", abbreviation: "" }))).toBeNull()
    })

    it("1 EL oil and 1 EL flour resolve to different gram values, both marked estimated", () => {
      const oil = convertToGrams(1, unit({ name: "EL" }), "Olivenöl")
      const flour = convertToGrams(1, unit({ name: "EL" }), "Mehl")
      expect(oil?.grams).not.toBeNull()
      expect(flour?.grams).not.toBeNull()
      expect(oil?.grams).not.toBe(flour?.grams)
      expect(oil?.estimated).toBe(true)
      expect(flour?.estimated).toBe(true)
    })

    it("1 TL sugar and 1 TL salt resolve to different gram values", () => {
      const sugar = convertToGrams(1, unit({ name: "TL" }), "Zucker")
      const salt = convertToGrams(1, unit({ name: "TL" }), "Salz")
      expect(sugar?.grams).not.toBe(salt?.grams)
    })

    it("supports German spoon/cup unit names", () => {
      expect(convertToGrams(1, unit({ name: "Esslöffel" }), "Honig")?.grams).toBeGreaterThan(0)
      expect(convertToGrams(1, unit({ name: "Teelöffel" }), "Honig")?.grams).toBeGreaterThan(0)
      expect(convertToGrams(1, unit({ name: "Tasse" }), "Milch")?.grams).toBeGreaterThan(0)
      expect(convertToGrams(1, unit({ name: "Prise" }), "Salz")?.grams).toBeGreaterThan(0)
    })

    it("falls back to a generic density for an unrecognized food", () => {
      expect(convertToGrams(1, unit({ name: "EL" }), "Xyzzy")).not.toBeNull()
    })
  })

  describe("piece/package units (Stück, Dose, Glas, Bund, Zehe, Stange, Packung, Päckchen)", () => {
    it("returns null for generic piece/slice without a specific food match", () => {
      expect(convertToGrams(2, unit({ name: "piece", abbreviation: "" }))).toBeNull()
      expect(convertToGrams(1, unit({ name: "slice", abbreviation: "" }))).toBeNull()
    })

    it("resolves a known food's piece weight (egg), marked estimated", () => {
      const result = convertToGrams(3, unit({ name: "Stück" }), "Ei")
      expect(result?.grams).toBe(159)
      expect(result?.estimated).toBe(true)
    })

    it("resolves Zehe (clove) for garlic", () => {
      expect(convertToGrams(2, unit({ name: "Zehe" }), "Knoblauch")?.grams).toBe(10)
    })

    it("resolves Bund for parsley", () => {
      expect(convertToGrams(1, unit({ name: "Bund" }), "Petersilie")?.grams).toBe(30)
    })

    it("falls back to a generic package weight for Dose/Glas/Packung when no food-specific match exists", () => {
      expect(convertToGrams(1, unit({ name: "Dose" }), "Kichererbsen")?.grams).toBe(400)
      expect(convertToGrams(1, unit({ name: "Glas" }), "Pesto")?.grams).toBe(340)
    })

    it("resolves a known container weight for a matched food (canned tomatoes)", () => {
      expect(convertToGrams(1, unit({ name: "Dose" }), "Tomate")?.grams).toBe(400)
    })
  })
})
