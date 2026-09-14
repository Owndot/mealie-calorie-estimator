import { describe, it, expect } from "vitest"
import { nameSimilarity, findMismatch, rankCandidates, MIN_ACCEPTABLE_SCORE, tokenize, categoryConflict, inferStateFromName } from "../../src/services/providers/ranking.js"

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

  it("rejects plain water matching a differently-named food that happens to contain \"water\"", () => {
    // Found live: "Wasser" matched USDA's "Water convolvulus, raw" — actually water spinach, a
    // leafy vegetable, not water — via a single shared token.
    expect(findMismatch("Wasser", "Water convolvulus, raw")).not.toBeNull()
    expect(findMismatch("Water", "Water chestnut")).not.toBeNull()
  })

  it("rejects mint (herb) matching mint-flavored candy/chocolate", () => {
    // Found live: "Minze" matched USDA's "Candies, NESTLE, AFTER EIGHT Mints" — a branded
    // chocolate confection, not the herb.
    expect(findMismatch("Minze", "Candies, NESTLE, AFTER EIGHT Mints")).not.toBeNull()
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

  it("rejects a spice query against 'Bread, Italian' — a baked-good composite, not a spice", () => {
    // Found live: "italienische Gewürzmischung" (Italian spice mix, 4g) matched USDA's
    // "Bread, Italian" — a whole bakery product with no relation to the seasoning blend.
    expect(categoryConflict("spice", "Bread, Italian")).toBe(true)
  })

  describe("German meat-prefix + dish-suffix compounds", () => {
    it("rejects a spice/seasoning query against a meat-prefixed dish compound", () => {
      // Found live: "Pfeffer" (pepper spice) matched BLS's "Schweinepfeffer" — "Schweine-"
      // (pork) + "-pfeffer", a whole savoury pork goulash dish, not a type of pepper. The
      // suffix-compound match was structurally identical to legitimate cases like
      // "Speisezwiebel"/"Zwiebel", but "-pfeffer" here is a German dish-naming convention
      // ("X Pfeffer" = an X-style peppery stew), not the food's literal identity.
      expect(categoryConflict("spice", "Schweinepfeffer")).toBe(true)
      expect(categoryConflict("seasoning", "Rehpfeffer")).toBe(true) // venison pepper stew
    })

    it("does NOT reject a legitimate animal-prefix + egg compound (Hühnerei)", () => {
      // "Hühnerei" (chicken's EGG) is animal-prefix + egg, not animal-prefix + dish-suffix —
      // a confirmed-correct BLS match that must not collide with the meat-dish rule above.
      expect(categoryConflict("egg", "Hühnerei roh")).toBe(false)
    })

    it("does not reject when the query category is broad enough to legitimately include a meat dish", () => {
      expect(categoryConflict("meat", "Schweinepfeffer")).toBe(false)
    })

    it("does not flag the bare animal word alone (no dish-suffix continuation to match)", () => {
      expect(categoryConflict("dairy", "Schwein")).toBe(false) // bare animal word, no continuation
      expect(categoryConflict("spice", "Salz")).toBe(false) // no animal prefix at all
    })

    it("still flags a genuine animal-prefixed compound that isn't an egg (e.g. pork meat vs dairy category)", () => {
      expect(categoryConflict("dairy", "Schweinefleisch")).toBe(true)
    })

    it("rejects a spice query against 'Hasenpfeffer' (rabbit pepper stew)", () => {
      expect(categoryConflict("spice", "Hasenbraten mariniert (Hasenpfeffer) mit Sauce")).toBe(true)
    })

    it("does NOT flag 'Haselnuss' (hazelnut) even though it starts with the same 4 letters as 'Hase' (rabbit)", () => {
      expect(categoryConflict("nut", "Haselnuss")).toBe(false)
      expect(categoryConflict("fat", "Haselnussöl")).toBe(false)
    })
  })

  describe("dessert, prepared-dish, and processed-product markers", () => {
    it("rejects a spice query against a frozen dessert sharing a descriptive word", () => {
      // Found live: "italienische Gewürzmischung" (Italian spice mix) matched USDA's "Italian
      // Ice" — a frozen dessert, unrelated to the seasoning blend.
      expect(categoryConflict("spice", "Italian Ice")).toBe(true)
    })

    it("rejects a fruit query against a dessert sharing the fruit's name", () => {
      // Found live: "Kirschtomate" (raw cherry tomato) matched USDA's "Cobbler, cherry".
      expect(categoryConflict("fruit", "Cobbler, cherry")).toBe(true)
    })

    it("rejects a legume query against a whole prepared dish built around it", () => {
      // Found live: "Rote Linse" (raw red lentil) matched USDA's "Lentil curry".
      expect(categoryConflict("legume", "Lentil curry")).toBe(true)
    })

    it("rejects a vegetable query against a stuffed/composite dish built around it", () => {
      // Found live: "grüne Paprika" (raw green bell pepper) matched USDA's "Stuffed green
      // pepper, Puerto Rican style".
      expect(categoryConflict("vegetable", "Stuffed green pepper, Puerto Rican style")).toBe(true)
    })

    it("rejects a spice query against a cured meat sharing a descriptive word", () => {
      // Found live: "italienische Gewürzmischung" (Italian spice mix) matched USDA's "Salami,
      // Italian, pork" — a cured meat, via the shared word "Italian".
      expect(categoryConflict("spice", "Salami, Italian, pork")).toBe(true)
    })

    it("rejects a beverage/water query against a baked-good sharing the word \"water\"", () => {
      // Found live: "Wasser" (plain water) matched USDA's "Crackers, water biscuits".
      expect(categoryConflict("beverage", "Crackers, water biscuits")).toBe(true)
      expect(categoryConflict("water", "Crackers, water biscuits")).toBe(true)
    })
  })
})

describe("inferStateFromName — English candidate state inference (USDA)", () => {
  it("infers 'dried' from 'powder' — not just 'dried'/'dehydrated'/'dry'", () => {
    // Found live: "Kirschtomate" (raw cherry tomato, 200g) matched USDA's "Tomato powder" — a
    // concentrated dehydrated product wildly wrong at that gram quantity — because "powder"
    // wasn't recognized as a dried-state indicator, so no state conflict was ever detected
    // against the query's "raw" state.
    expect(inferStateFromName("Tomato powder")).toBe("dried")
    expect(inferStateFromName("Garlic powder")).toBe("dried")
  })

  it("infers raw/cooked/dried correctly from typical USDA description phrasing", () => {
    expect(inferStateFromName("Bananas, raw")).toBe("raw")
    expect(inferStateFromName("Potato, boiled, without skin")).toBe("cooked")
    expect(inferStateFromName("Onions, dehydrated flakes")).toBe("dried")
  })

  it("returns 'unknown' when no state word is present", () => {
    expect(inferStateFromName("Chicken, breast")).toBe("unknown")
  })
})
