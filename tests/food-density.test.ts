import { describe, it, expect } from "vitest"
import { estimateSpoonCupGrams, estimatePieceWeightGrams, estimateVolumeGrams } from "../src/services/food-density.js"

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

describe("estimateVolumeGrams — ml/l are density-dependent, never a fixed 1 g/ml assumption", () => {
  it("returns null for a non-volume unit name", () => {
    expect(estimateVolumeGrams(1, "el", "Wasser")).toBeNull()
  })

  it("returns null for an unrecognized food — no generic default density for volume", () => {
    expect(estimateVolumeGrams(200, "ml", "unrecognized-liquid-xyz")).toBeNull()
  })

  it("water resolves to ~1 g/ml", () => {
    expect(estimateVolumeGrams(200, "ml", "Wasser")).toBeCloseTo(200, 0)
  })

  it("olive oil resolves to a different (lower) density than water", () => {
    const water = estimateVolumeGrams(200, "ml", "Wasser")!
    const oil = estimateVolumeGrams(200, "ml", "Olivenöl")!
    expect(oil).not.toBe(water)
    expect(oil).toBeLessThan(water)
  })

  it("honey resolves to a higher density than water", () => {
    const water = estimateVolumeGrams(100, "ml", "Wasser")!
    const honey = estimateVolumeGrams(100, "ml", "Honig")!
    expect(honey).toBeGreaterThan(water)
  })

  it("liter scales as 1000x ml for the same food", () => {
    const l = estimateVolumeGrams(1, "l", "Milch")!
    const ml = estimateVolumeGrams(1000, "ml", "Milch")!
    expect(l).toBeCloseTo(ml, 5)
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
