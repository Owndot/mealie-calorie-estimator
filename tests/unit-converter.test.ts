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
  it("uses standardQuantity when available (Mealie conversion takes precedence) and marks it not estimated", () => {
    const u = unit({ name: "cup", standardQuantity: 240, standardUnit: "ml" })
    const result = convertToGrams(2, u)
    expect(result?.grams).toBe(480)
    expect(result?.estimated).toBe(false)
  })

  it("uses standardQuantity with g unit", () => {
    const u = unit({ name: "custom", standardQuantity: 100, standardUnit: "g" })
    expect(convertToGrams(3, u)?.grams).toBe(300)
  })

  it("uses fixed conversion for food-independent units, not estimated", () => {
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

  it("handles ml to grams via standardUnit", () => {
    const u = unit({ name: "liter", standardQuantity: 1, standardUnit: "l" })
    expect(convertToGrams(2, u)?.grams).toBe(2000)
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
