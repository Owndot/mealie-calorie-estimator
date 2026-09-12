import { describe, it, expect } from "vitest"
import { convertToGrams, normalizeUnitName, resolveUnitName } from "../src/services/unit-converter.js"
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
  it("uses standardQuantity when available", () => {
    const u = unit({ name: "cup", standardQuantity: 240, standardUnit: "ml" })
    expect(convertToGrams(2, u)).toBe(480)
  })

  it("uses standardQuantity with g unit", () => {
    const u = unit({ name: "custom", standardQuantity: 100, standardUnit: "g" })
    expect(convertToGrams(3, u)).toBe(300)
  })

  it("uses fallback for known units", () => {
    expect(convertToGrams(1, unit({ name: "kg" }))).toBe(1000)
    expect(convertToGrams(2, unit({ name: "tbsp" }))).toBe(30)
    expect(convertToGrams(3, unit({ name: "tsp" }))).toBe(15)
    expect(convertToGrams(1, unit({ name: "oz" }))).toBe(28.35)
    expect(convertToGrams(1, unit({ name: "lb" }))).toBe(453.592)
    expect(convertToGrams(1, unit({ name: "pinch" }))).toBe(0.4)
  })

  it("returns null for unknown units", () => {
    expect(convertToGrams(1, unit({ name: "handful", abbreviation: "" }))).toBeNull()
  })

  it("returns null for piece/slice units", () => {
    expect(convertToGrams(2, unit({ name: "piece" }))).toBeNull()
    expect(convertToGrams(1, unit({ name: "slice" }))).toBeNull()
  })

  it("returns null when unit is null", () => {
    expect(convertToGrams(1, null)).toBeNull()
  })

  it("handles ml to grams via standardUnit", () => {
    const u = unit({ name: "liter", standardQuantity: 1, standardUnit: "l" })
    expect(convertToGrams(2, u)).toBe(2000)
  })

  it.each(["Prise", "Prisen", "pinch", "pinches", " PRISE "])("converts %s deterministically", name => {
    expect(convertToGrams(2, unit({ name, abbreviation: null }))).toBeCloseTo(0.8)
  })

  it("keeps explicit standard quantities for a pinch", () => {
    expect(convertToGrams(2, unit({ name: "Prise", standardQuantity: 0.6, standardUnit: "g" }))).toBe(1.2)
  })
})

describe("unit normalization", () => {
  it.each([
    ["TL", "teaspoon"], ["tl", "teaspoon"], ["TL.", "teaspoon"],
    ["Teel.", "teaspoon"], ["Teelöffel", "teaspoon"], [" TEELOEFFEL ", "teaspoon"],
    ["EL", "tablespoon"], ["el.", "tablespoon"], ["Essl.", "tablespoon"],
    ["Esslöffel", "tablespoon"], ["Eßlöffel", "tablespoon"],
    ["Prise", "pinch"], ["PRISEN.", "pinch"],
    ["Stk", "piece"], ["Stk.", "piece"], ["Stück", "piece"], ["STÜCKE", "piece"],
    ["g", "gram"], ["Gramm", "gram"], ["G.", "gram"],
    ["kg", "kilogram"], ["Kilogramm", "kilogram"], ["KG.", "kilogram"],
    ["ml", "milliliter"], ["Milliliter", "milliliter"], ["ML.", "milliliter"],
    ["l", "liter"], ["Liter", "liter"], ["L.", "liter"],
    ["tsp.", "teaspoon"], ["teaspoons", "teaspoon"],
    ["TBSP", "tablespoon"], ["tablespoons", "tablespoon"],
    ["pinches", "pinch"], ["pieces", "piece"], ["grams", "gram"],
    ["kilograms", "kilogram"], ["milliliters", "milliliter"], ["liters", "liter"],
  ])("normalizes %s to %s", (input, canonical) => {
    expect(normalizeUnitName(input)).toBe(canonical)
    expect(convertToGrams(2, unit({ name: input, abbreviation: null })))
      .toBe(convertToGrams(2, unit({ name: canonical, abbreviation: null })))
  })

  it.each([
    ["teaspoon", 5], ["tablespoon", 15], ["pinch", 0.4], ["gram", 1],
    ["kilogram", 1000], ["milliliter", 1], ["liter", 1000], ["cup", 240],
    ["ounces", 28.35], ["lbs", 453.592], ["dashes", 0.3], ["cloves", 5],
  ])("retains the English %s conversion", (name, grams) => {
    expect(convertToGrams(1, unit({ name, abbreviation: null }))).toBe(grams)
  })

  it("uses a recognized abbreviation when the display name is unknown", () => {
    const u = unit({ name: "kleiner Löffel", abbreviation: "TL." })
    expect(resolveUnitName(u)).toBe("teaspoon")
    expect(convertToGrams(1, u)).toBe(5)
  })

  it("does not invent a weight for Stück even if the abbreviation conflicts", () => {
    expect(convertToGrams(1, unit({ name: "Stück", abbreviation: "g" }))).toBeNull()
  })

  it.each([["Gramm.", 12], ["KG", 12000], ["Milliliter", 12], ["Liter.", 12000]])(
    "normalizes explicit standard unit %s", (standardUnit, expected) => {
      expect(convertToGrams(2, unit({ name: "EL", standardQuantity: 6, standardUnit }))).toBe(expected)
    },
  )

  it("preserves different explicit gram weights for spoon measures", () => {
    const oilSpoon = unit({ name: "EL", standardQuantity: 13.5, standardUnit: "g" })
    const flourSpoon = unit({ name: "Esslöffel", standardQuantity: 8, standardUnit: "Gramm" })
    expect(convertToGrams(1, oilSpoon)).toBe(13.5)
    expect(convertToGrams(1, flourSpoon)).toBe(8)
  })

  it("preserves unknown unit names for food-specific LLM estimation", () => {
    expect(resolveUnitName(unit({ name: "Handvoll", abbreviation: null }))).toBe("Handvoll")
    expect(convertToGrams(1, unit({ name: "Handvoll", abbreviation: null }))).toBeNull()
    expect(convertToGrams(1, unit({ name: "kg/ml", abbreviation: null }))).toBeNull()
  })
})
