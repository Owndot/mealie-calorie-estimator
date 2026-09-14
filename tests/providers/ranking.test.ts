import { describe, it, expect } from "vitest"
import { nameSimilarity, findMismatch, rankCandidates, MIN_ACCEPTABLE_SCORE, tokenize, categoryConflict } from "../../src/services/providers/ranking.js"

describe("tokenize — defensive against non-string input from external provider APIs", () => {
  // Live acceptance test finding: OFF's real /search response returns `brands` as a string
  // array, not a string as the type once assumed, which crashed tokenize() on every real
  // candidate (`s.toLowerCase is not a function`). off-provider.ts now normalizes that at its
  // own boundary, but tokenize() itself must also degrade gracefully as defense-in-depth.
  it("returns an empty array instead of throwing for an array input", () => {
    // @ts-expect-error deliberately passing the wrong runtime type, as untrusted external data would
    expect(tokenize(["Nutella", "Ferrero"])).toEqual([])
  })

  it("returns an empty array instead of throwing for null/undefined/number input", () => {
    // @ts-expect-error deliberately passing the wrong runtime type
    expect(tokenize(null)).toEqual([])
    // @ts-expect-error deliberately passing the wrong runtime type
    expect(tokenize(undefined)).toEqual([])
    // @ts-expect-error deliberately passing the wrong runtime type
    expect(tokenize(42)).toEqual([])
  })
})

describe("nameSimilarity", () => {
  it("returns 1 for identical names", () => {
    expect(nameSimilarity("Mehl", "Mehl")).toBe(1)
  })

  it("returns 0 for completely unrelated names", () => {
    expect(nameSimilarity("Mehl", "Autoreifen")).toBe(0)
  })

  it("returns a partial score for overlapping tokens", () => {
    const score = nameSimilarity("frischer ingwer", "ingwer")
    expect(score).toBeGreaterThan(0)
    expect(score).toBeLessThan(1)
  })
})

describe("findMismatch — obvious mismatch rejection", () => {
  it("rejects fresh ginger matching ginger ale", () => {
    expect(findMismatch("Ingwer", "Ginger Ale")).not.toBeNull()
  })

  it("rejects salt matching an electrolyte drink", () => {
    expect(findMismatch("Salz", "Electrolyte Sports Drink")).not.toBeNull()
  })

  it("rejects coriander matching coriander chutney", () => {
    expect(findMismatch("Koriander", "Coriander Chutney")).not.toBeNull()
  })

  it("does not reject when the query itself explicitly names the flagged product", () => {
    expect(findMismatch("Ginger Ale", "Ginger Ale")).toBeNull()
  })

  it("does not flag unrelated foods", () => {
    expect(findMismatch("Mehl", "Weizenmehl")).toBeNull()
  })
})

describe("rankCandidates", () => {
  it("never blindly picks the first candidate — ranks by similarity/completeness and orders best first", () => {
    const ranked = rankCandidates("Milch", null, [
      { name: "Autoreifen 205/55", brand: null, hasCompleteNutrients: true },
      { name: "Vollmilch 3.5%", brand: null, hasCompleteNutrients: true },
    ])
    expect(ranked[0].candidate.name).toBe("Vollmilch 3.5%")
  })

  it("penalizes candidates with incomplete nutrient data", () => {
    const ranked = rankCandidates("Milch", null, [
      { name: "Milch", brand: null, hasCompleteNutrients: false },
      { name: "Milch Bio", brand: null, hasCompleteNutrients: true },
    ])
    expect(ranked[0].candidate.name).toBe("Milch Bio")
  })

  it("marks mismatched candidates with a mismatchReason and a heavily penalized score", () => {
    const ranked = rankCandidates("Ingwer", null, [
      { name: "Ginger Ale", brand: null, hasCompleteNutrients: true },
    ])
    expect(ranked[0].mismatchReason).not.toBeNull()
    expect(ranked[0].score).toBeLessThan(MIN_ACCEPTABLE_SCORE)
  })

  it("gives a brand-evidence bonus when query brand matches candidate brand", () => {
    const withMatch = rankCandidates("Joghurt", "Danone", [{ name: "Joghurt", brand: "Danone", hasCompleteNutrients: true }])
    const withoutBrand = rankCandidates("Joghurt", null, [{ name: "Joghurt", brand: null, hasCompleteNutrients: true }])
    expect(withMatch[0].score).toBeGreaterThan(withoutBrand[0].score)
  })

  it("rejects a candidate whose known state conflicts with the query's known state", () => {
    const ranked = rankCandidates("Kartoffel", null, [
      { name: "Kartoffel", brand: null, hasCompleteNutrients: true, state: "raw" },
    ], { queryState: "cooked" })
    expect(ranked[0].mismatchReason).not.toBeNull()
  })

  it("does not penalize a candidate whose state is unknown, even when the query's state is known", () => {
    const ranked = rankCandidates("Kartoffel", null, [
      { name: "Kartoffel", brand: null, hasCompleteNutrients: true, state: "unknown" },
    ], { queryState: "cooked" })
    expect(ranked[0].mismatchReason).toBeNull()
  })

  it("rejects a candidate via categoryConflict when queryCategory is set", () => {
    const ranked = rankCandidates("Paprika", null, [
      { name: "Paprikaspeckwurst", brand: null, hasCompleteNutrients: true },
    ], { queryCategory: "spice" })
    expect(ranked[0].mismatchReason).not.toBeNull()
  })

  it("applies a dataType scoring function as a ranking signal, not a hard filter", () => {
    const ranked = rankCandidates("Banana", null, [
      { name: "Banana, raw", brand: null, hasCompleteNutrients: true, dataType: "Foundation" },
      { name: "BANANA", brand: "Dole", hasCompleteNutrients: true, dataType: "Branded" },
    ], { dataTypeScore: (dt) => (dt === "Foundation" ? 20 : dt === "Branded" ? -20 : 0) })
    expect(ranked[0].candidate.name).toBe("Banana, raw")
  })
})

describe("categoryConflict", () => {
  it("rejects a strict raw-ingredient category against a composite/manufactured product name", () => {
    expect(categoryConflict("spice", "Paprikaspeckwurst")).toBe(true)
    expect(categoryConflict("seasoning", "Salzstangen")).toBe(true)
    expect(categoryConflict("herb", "Rote-Linsensuppe mit Koriander")).toBe(true)
    expect(categoryConflict("vegetable", "Tomatensaft")).toBe(true) // vegetable vs beverage (juice)
  })

  it("does not reject when the query category is broad enough to legitimately include product forms", () => {
    // "meat" is deliberately excluded from the strict set — a sausage can BE the right meat answer.
    expect(categoryConflict("meat", "Bratwurst")).toBe(false)
  })

  it("does not reject when the category is unknown/null", () => {
    expect(categoryConflict(null, "Paprikaspeckwurst")).toBe(false)
  })

  it("does not reject a candidate with no composite-product marker at all", () => {
    expect(categoryConflict("spice", "Paprika, edelsüß")).toBe(false)
  })
})
