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

// Found live: `/\bbrühe\b/` cannot fire inside "Gemüsebrühe" — JS \b needs a non-word char before
// it, and in a German compound the preceding letter is a word char. The ingredient therefore fell
// through to an unvalidated LLM gram estimate, which is how 750 ml became 75000 g. Separately,
// only canonicalEnglish was ever passed in, so a degraded classification handed this table a raw
// German name it structurally could not match.
describe("identity-aware density resolution", () => {
  const ml = (food: any) => estimateVolumeGrams(100, "ml", food)

  it("resolves German compounds via opt-in head matching", () => {
    for (const n of ["Gemüsebrühe", "Hühnerbrühe", "Rinderbrühe", "Kokosmilch", "Buttermilch",
                     "Schlagsahne", "Orangensaft", "Leitungswasser", "Mineralwasser"]) {
      expect(ml(n)).toBe(100) // water-based liquid, 1.0 g/ml
    }
    expect(ml("Sonnenblumenöl")).toBeCloseTo(90.7, 1)
    expect(ml("Rapsöl")).toBeCloseTo(90.7, 1)
    expect(ml("Öl")).toBeCloseTo(90.7, 1) // bare "Öl" never matched before: \b fails before "ö"
  })

  it("keeps every previously-working match working", () => {
    expect(ml("vegetable broth")).toBe(100)
    expect(ml("broth")).toBe(100)
    expect(ml("coconut milk")).toBe(100)
    expect(ml("cream")).toBe(100)
    expect(ml("water")).toBe(100)
    expect(ml("olive oil")).toBeCloseTo(90.7, 1)
    expect(ml("Olivenöl")).toBeCloseTo(90.7, 1)
  })

  // Real data gap found by the live block-3 probe: Rotwein missed this table entirely and the LLM
  // answered 0.85 g/ml — inside the catastrophic guard but wrong for a water-based beverage.
  it("resolves wine through the generic-liquid category, not a Rotwein special case", () => {
    for (const n of ["Rotwein", "Weißwein", "Wein", "red wine", "white wine", "wine", "Glühwein"]) {
      expect(ml(n)).toBe(100)
    }
  })

  it("does NOT match foods where the shared word is the modifier, not the head", () => {
    // Each of these WOULD match under naive substring containment.
    for (const n of ["Wassermelone", "Milchreis", "Saftschorle", "Brühwurst", "Ölsardinen",
                     "Buttermilchbrot", "Weintrauben", "Rotweinessig", "Weinessig", "Weinbrand"]) {
      expect(ml(n)).toBeNull()
    }
  })

  it("does not fall for the corn/acorn class — exact tokens, never substrings", () => {
    expect(estimateSpoonCupGrams(1, "el", "acorn")).toBe(12)      // generic default, not a category
    expect(estimateSpoonCupGrams(1, "el", "Salzkartoffeln")).toBe(12) // not the salt category
    expect(estimateSpoonCupGrams(1, "el", "Salz")).toBe(18)       // the real salt still works
  })

  it("prefers the core identity, then canonical names, then the raw structured name", () => {
    // Only the German core is usable — an English-only table lookup would have missed this.
    expect(ml({ coreFoodGerman: "Brühe", structuredName: "Gemüsebrühe" })).toBe(100)
    // Degraded classification: structuredName is all that exists.
    expect(ml({ structuredName: "Hühnerbrühe" })).toBe(100)
    // A usable English canonical works even when the German side is absent.
    expect(ml({ canonicalEnglish: "red wine" })).toBe(100)
    // Nothing usable anywhere -> null, so the caller falls through honestly.
    expect(ml({ structuredName: "Rinderbraten" })).toBeNull()
  })

  it("still requires BOTH a cheese word and a grated word for the grated-cheese density", () => {
    expect(estimateSpoonCupGrams(1, "el", "geriebener Parmesan")).toBe(5)
    expect(estimateSpoonCupGrams(1, "el", "grated cheese")).toBe(5)
    expect(estimateSpoonCupGrams(1, "el", "Parmesan")).toBe(12) // plain cheese -> generic default
  })
})

// Paniermehl is linguistically a -mehl compound but semantically breadcrumbs. The "mehl" compound
// head would silently hand it flour's density (0.52 g/ml) — the kind of semantic accident the head
// rule can produce, so breadcrumbs get their own category ahead of flour. An exclusion would be
// worse than the bug: it would drop to the generic-solid DEFAULT (0.8 g/ml).
describe("compound-head semantic exceptions", () => {
  const ml = (n: string) => estimateVolumeGrams(100, "ml", n)

  it("does not give Paniermehl flour density", () => {
    expect(ml("Paniermehl")).not.toBe(52)   // flour
    expect(ml("Paniermehl")).not.toBe(80)   // generic-solid default
    expect(ml("Paniermehl")).toBe(40)       // breadcrumb category
  })

  it("covers the German and English breadcrumb names", () => {
    for (const n of ["Paniermehl", "Semmelbrösel", "Semmelbrösel", "breadcrumbs", "panko", "bread crumbs"]) {
      expect(ml(n)).toBe(40)
    }
  })

  it("keeps every real -mehl flour matching flour", () => {
    for (const n of ["Dinkelmehl", "Vollkornmehl", "Weizenmehl", "Mandelmehl", "Kokosmehl", "Kichererbsenmehl", "Mehl"]) {
      expect(ml(n)).toBe(52)
    }
  })

  it("Puderzucker still resolves as a fine powder, not as granulated sugar", () => {
    expect(ml("Puderzucker")).toBe(52)
    expect(ml("Rohrzucker")).toBeCloseTo(83.3, 1)
  })
})
