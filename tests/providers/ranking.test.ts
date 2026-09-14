import { describe, it, expect } from "vitest"
import { nameSimilarity, findMismatch, rankCandidates, MIN_ACCEPTABLE_SCORE, tokenize } from "../../src/services/providers/ranking.js"

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
})
