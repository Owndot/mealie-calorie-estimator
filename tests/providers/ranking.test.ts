import { describe, it, expect } from "vitest"
import { nameSimilarity, findMismatch, rankCandidates, MIN_ACCEPTABLE_SCORE, tokenize, categoryConflict, inferStateFromName, foodTypeConflict } from "../../src/services/providers/ranking.js"

describe("foodTypeConflict — PRIMARY hard-rejection signal, checked before any lexical score", () => {
  it("rejects a simple query against a composite_dish candidate", () => {
    expect(foodTypeConflict("simple", "composite_dish")).toBe(true)
  })

  it("rejects a processed_single_food query against a composite_dish candidate", () => {
    expect(foodTypeConflict("processed_single_food", "composite_dish")).toBe(true)
  })

  it("allows a composite_dish query to match a composite_dish candidate", () => {
    // A genuinely composite ingredient (e.g. the Mealie ingredient literally IS "Lasagne") must
    // still be able to match BLS's own composite entry for it.
    expect(foodTypeConflict("composite_dish", "composite_dish")).toBe(false)
  })

  it("never rejects when either side is unknown — permissive degradation, not a block", () => {
    expect(foodTypeConflict("unknown", "composite_dish")).toBe(false)
    expect(foodTypeConflict("simple", "unknown")).toBe(false)
    expect(foodTypeConflict("unknown", "unknown")).toBe(false)
  })

  it("does not reject a simple query against a simple or processed_single_food candidate", () => {
    expect(foodTypeConflict("simple", "simple")).toBe(false)
    expect(foodTypeConflict("simple", "processed_single_food")).toBe(false)
  })
})

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

  it("rejects plain chicken breast/fillet matching a breaded/battered chicken product", () => {
    // Found live: "Hähnchenbrustfilets" (plain chicken breast) matched "Chicken breast tenders,
    // breaded, uncooked" — categoryConflict alone can't catch this since "meat"/"poultry" are
    // deliberately excluded from STRICT_RAW_INGREDIENT_CATEGORIES.
    expect(findMismatch("Hähnchenbrustfilets", "Chicken breast tenders, breaded, uncooked")).not.toBeNull()
    expect(findMismatch("chicken breast", "Chicken, breast, breaded and fried")).not.toBeNull()
  })

  it("does not reject a chicken-breast query against a plain, unbreaded candidate", () => {
    expect(findMismatch("Hähnchenbrustfilets", "Chicken, breast, meat only, raw")).toBeNull()
  })

  it("rejects a bare whole-egg query matching egg white/yolk or an egg-containing/egg-free composite", () => {
    expect(findMismatch("Ei", "Egg, white, raw")).not.toBeNull()
    expect(findMismatch("Ei", "Egg, yolk, raw")).not.toBeNull()
    expect(findMismatch("egg", "Egg pasta, dry")).not.toBeNull()
    // Found live: "Ei" matched BLS's own English name for "Teigwaren eifrei, roh" (egg-FREE pasta).
    expect(findMismatch("Ei", "Teigwaren eifrei, roh")).not.toBeNull()
  })

  it("does not reject a whole-egg query against a plain whole-egg candidate", () => {
    expect(findMismatch("Ei", "Egg, whole, raw, fresh")).toBeNull()
  })

  it("does not reject when the query itself explicitly names the egg part (Eiweiß/Eigelb)", () => {
    expect(findMismatch("Eiweiß", "Egg, white, raw")).toBeNull()
    expect(findMismatch("Eigelb", "Egg, yolk, raw")).toBeNull()
  })

  it("rejects a bare generic-oil query matching a candidate naming a specific oil type", () => {
    // "generic Öl must remain generic oil, never inventing a specific oil" — selecting a specific
    // type the query never named would amount to guessing.
    expect(findMismatch("Öl", "Coconut oil")).not.toBeNull()
    expect(findMismatch("Oil", "Olive oil, extra virgin")).not.toBeNull()
  })

  it("does not reject when the query itself names a specific oil (Olivenöl, Kokosöl)", () => {
    expect(findMismatch("Olivenöl", "Olive oil, extra virgin")).toBeNull()
    expect(findMismatch("Kokosöl", "Coconut oil")).toBeNull()
  })

  it("does not reject a bare oil query against a plain, unspecified-oil candidate", () => {
    expect(findMismatch("Öl", "Vegetable oil")).toBeNull()
  })

  it("rejects a bare oil query matching almond oil specifically", () => {
    // Found live in the mandatory manual-provenance audit, in two separate recipes: bare "Öl"
    // matched USDA's "Oil, almond" — "almond" was missing from the forbidden-oil-type list.
    expect(findMismatch("Öl", "Oil, almond")).not.toBeNull()
  })

  it("rejects a bare oil query matching ANY specific USDA \"Oil, <type>\" candidate structurally, not just enumerated names", () => {
    // Found live on the next redeploy: bare "Öl" matched USDA's "Oil, babassu" — a specific oil
    // type not in the enumerated name list, proving enumeration alone is whack-a-mole. The
    // structural "Oil, <type>" check catches this and any other USDA-named oil type generically.
    expect(findMismatch("Öl", "Oil, babassu")).not.toBeNull()
    expect(findMismatch("oil", "Oil, grapeseed")).not.toBeNull()
  })

  it("does not reject a bare oil query against USDA's generic \"Oil, vegetable\"/\"Oil, cooking\" naming", () => {
    expect(findMismatch("Öl", "Oil, vegetable")).toBeNull()
    expect(findMismatch("Öl", "Oil, cooking, NFS")).toBeNull()
  })

  it("does not reject a bare pepper query matching plain black pepper — the correct match", () => {
    // Positive case: "Pfeffer" must still be able to match its correct BLS/USDA target (plain
    // black pepper spice) — only composite dishes STYLED with "-pfeffer" are rejected.
    expect(findMismatch("Pfeffer", "Pfeffer, schwarz, gemahlen")).toBeNull()
    expect(findMismatch("Pfeffer", "Spices, pepper, black")).toBeNull()
    expect(categoryConflict("spice", "Pfeffer, schwarz, gemahlen")).toBe(false)
  })

  it("rejects pepper (spice) matching the Dr Pepper soft drink brand", () => {
    // Found live in the mandatory manual-provenance audit, in two separate recipes: bare
    // "Pfeffer" matched OFF's "Dr pepper" — a branded soda, via the shared word "pepper".
    expect(findMismatch("Pfeffer", "Dr pepper")).not.toBeNull()
    expect(findMismatch("pepper", "Dr. Pepper")).not.toBeNull()
  })

  it("rejects bell pepper (vegetable) matching a dried pepper/paprika SPICE product", () => {
    // Found live: "rote Paprika"/"grüne Paprika" (bell pepper, a vegetable) translated to
    // canonicalEnglish "red/green bell pepper" matched USDA's "Spices, pepper, red or cayenne" —
    // a dried chili spice, via the shared word "pepper". Both are "simple" foodType, so
    // foodTypeConflict alone can't catch this within-simple category mismatch.
    expect(findMismatch("red bell pepper", "Spices, pepper, red or cayenne")).not.toBeNull()
    expect(findMismatch("green bell pepper", "Spices, paprika")).not.toBeNull()
  })

  it("rejects pepper (spice) matching a raw vegetable pepper variety", () => {
    // Found live on the redeploy right after the Dr-Pepper fix: bare "Pfeffer" then matched
    // USDA's "Pepper, banana, raw" — a raw vegetable pepper variety, not the ground spice.
    expect(findMismatch("Pfeffer", "Pepper, banana, raw")).not.toBeNull()
    expect(findMismatch("pepper", "Peppers, sweet, red, raw")).not.toBeNull()
  })

  it("does not reject bare pepper matching the correct black/white spice candidates", () => {
    expect(findMismatch("Pfeffer", "Spices, pepper, black")).toBeNull()
    expect(findMismatch("pepper", "Spices, pepper, white")).toBeNull()
  })

  it("does not reject a bell-pepper query against its correct vegetable-pepper candidate (positive case)", () => {
    // The vegetable-pepper rule must never fire for the legitimate "bell pepper" query the rule
    // above exists to protect — only for the bare spice query "Pfeffer"/"pepper".
    expect(findMismatch("red bell pepper", "Peppers, sweet, red, raw")).toBeNull()
  })

  it("rejects cherry tomato (vegetable) matching cherries (the fruit)", () => {
    // Found live: "Kirschtomate" (cherry tomato) translated to canonicalEnglish "cherry tomato"
    // matched USDA's "Cherries, sweet, raw" — the fruit, via the shared word "cherry".
    expect(findMismatch("cherry tomato", "Cherries, sweet, raw")).not.toBeNull()
  })

  it("does not reject cherry tomato against a candidate that legitimately mentions both words", () => {
    expect(findMismatch("cherry tomato", "Tomatoes, cherry, raw")).toBeNull()
  })

  it("rejects plain water matching a branded tonic water product", () => {
    // Found live: "Wasser" (plain water) matched OFF's "Tonic Water" — a sweetened, flavored
    // soft drink with real calories/sugar, not plain water.
    expect(findMismatch("Wasser", "Tonic Water Hofer")).not.toBeNull()
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

  it("rejects a composite_dish candidate for a simple query even with a perfect lexical score", () => {
    // "A high lexical score must never rescue a semantic mismatch" — the candidate name matches
    // the query exactly, but foodType conflict must still hard-reject it, checked before scoring.
    const ranked = rankCandidates("Linsensuppe", null, [
      { name: "Linsensuppe", brand: null, hasCompleteNutrients: true, foodType: "composite_dish" },
    ], { queryFoodType: "simple" })
    expect(ranked[0].mismatchReason).toMatch(/food type conflict/)
    expect(ranked[0].score).toBeLessThan(MIN_ACCEPTABLE_SCORE)
  })

  it("allows a composite query to match a composite candidate (a genuinely composite ingredient)", () => {
    // The opposite direction: querying "Lasagne" (the ingredient itself IS a prepared dish) must
    // still be able to match a composite_dish candidate of the same name.
    const ranked = rankCandidates("Lasagne", null, [
      { name: "Lasagne", brand: null, hasCompleteNutrients: true, foodType: "composite_dish" },
    ], { queryFoodType: "composite_dish" })
    expect(ranked[0].mismatchReason).toBeNull()
    expect(ranked[0].score).toBeGreaterThanOrEqual(MIN_ACCEPTABLE_SCORE)
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

    it("rejects a vegetable query against a sauce/condiment product built around it", () => {
      // Found live in the mandatory manual-provenance audit: "grüne Paprika" (raw green bell
      // pepper) matched OFF's "Green Pepper Sauce"; "Kirschtomate" (raw cherry tomato) matched
      // USDA's "Tomato products, canned, sauce, with tomato tidbits".
      expect(categoryConflict("vegetable", "Green Pepper Sauce")).toBe(true)
      expect(categoryConflict("fruit", "Tomato products, canned, sauce, with tomato tidbits")).toBe(true)
    })

    it("rejects a spice query against a liquid salad dressing sharing a descriptive word", () => {
      // Found live: "italienische Gewürzmischung" (a dry Italian spice blend) matched USDA's
      // "Creamy Italian dressing" — a liquid condiment, not a dry seasoning.
      expect(categoryConflict("spice", "Creamy Italian dressing")).toBe(true)
    })

    it("rejects a spice query against a cream cheese spread sharing a descriptive word", () => {
      // Found live, in two separate recipes: "Paprikapulver" (a dry spice) matched OFF's "Paprika
      // Frischkäsezubereitung" — a paprika-flavored cream cheese SPREAD, a dairy product.
      expect(categoryConflict("spice", "Paprika Frischkäsezubereitung")).toBe(true)
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

  it("infers 'cooked' (a raw-conflicting state) from 'pickled'", () => {
    // Found live: raw "Rote Zwiebel" (red onion) matched OFF's "Pickled red onion" — a
    // vinegar-preserved product with a materially different profile than fresh onion.
    // FoodState has no dedicated "pickled" value; grouping it with "cooked" still gets the
    // useful behavior of conflicting with a "raw" query.
    expect(inferStateFromName("Pickled red onion")).toBe("cooked")
  })
})
