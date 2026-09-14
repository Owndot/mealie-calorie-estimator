import { describe, it, expect } from "vitest"
import { estimateSpoonCupGrams, estimatePieceWeightGrams } from "../src/services/food-density.js"

describe("estimateSpoonCupGrams", () => {
  it("returns null for a non-spoon/cup unit name", () => {
    expect(estimateSpoonCupGrams(1, "kg", "Mehl")).toBeNull()
  })

  it("oil and flour resolve to different EL gram weights", () => {
    const oil = estimateSpoonCupGrams(1, "el", "Olivenöl")
    const flour = estimateSpoonCupGrams(1, "el", "Mehl")
    expect(oil).not.toBe(flour)
    expect(oil).toBeGreaterThan(flour!)
  })

  it("scales linearly with quantity", () => {
    expect(estimateSpoonCupGrams(3, "el", "Zucker")).toBeCloseTo(estimateSpoonCupGrams(1, "el", "Zucker")! * 3)
  })

  it("falls back to a generic density for unknown foods", () => {
    expect(estimateSpoonCupGrams(1, "tl", "some-unrecognized-ingredient")).not.toBeNull()
  })
})

describe("estimatePieceWeightGrams", () => {
  it("returns null for an unmapped unit/food combination", () => {
    expect(estimatePieceWeightGrams(1, "stück", "some-unrecognized-ingredient")).toBeNull()
  })

  it("resolves egg piece weight", () => {
    expect(estimatePieceWeightGrams(2, "stück", "Ei")).toBe(106)
  })

  it("resolves garlic clove weight", () => {
    expect(estimatePieceWeightGrams(3, "zehe", "Knoblauch")).toBe(15)
  })

  it("falls back to a generic container weight for Dose/Glas without a food-specific match", () => {
    expect(estimatePieceWeightGrams(1, "dose", "unrecognized-canned-thing")).toBe(400)
    expect(estimatePieceWeightGrams(1, "glas", "unrecognized-jarred-thing")).toBe(340)
  })
})
