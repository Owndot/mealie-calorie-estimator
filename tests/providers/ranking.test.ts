import { describe, it, expect } from "vitest"
import {
  nameSimilarity, findMismatch, rankCandidates, MIN_ACCEPTABLE_SCORE, tokenize, categoryConflict,
  inferStateFromName, foodTypeConflict, coreIdentityConflict, coreIdentityScoreAdjustment, cachedMatchConflict,
} from "../../src/services/providers/ranking.js"

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

  it("rejects a bare oil query matching ANY specific oil type structurally, in either USDA naming convention", () => {
    // Found live across three separate redeploys: bare "Öl" matched USDA's "Oil, almond", then
    // "Oil, babassu" (after enumerating "almond"), then "Cottonseed oil" (after a comma-format-only
    // structural check) — USDA's SR Legacy dataset phrases oils as "Oil, <type>" while Survey
    // (FNDDS) phrases them "<type> oil", so neither enumeration nor one naming convention
    // generalizes. The tokenized "every word must be a recognized generic oil word" check does.
    expect(findMismatch("Öl", "Oil, babassu")).not.toBeNull()
    expect(findMismatch("oil", "Oil, grapeseed")).not.toBeNull()
    expect(findMismatch("Öl", "Cottonseed oil")).not.toBeNull()
    expect(findMismatch("oil", "Sesame oil")).not.toBeNull()
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

  it("infers 'raw' from 'fresh' — a dried query must still conflict with a fresh candidate", () => {
    // Found live: "getrocknete Petersilie"/"getrockneter Thymian"/"getrockneter Basilikum" (all
    // explicitly DRIED queries) matched USDA's "Parsley, fresh"/"Thyme, fresh"/"Basil, fresh" —
    // the opposite state — because "fresh" wasn't recognized as raw-equivalent, so the
    // dried-vs-raw state conflict never fired.
    expect(inferStateFromName("Parsley, fresh")).toBe("raw")
    expect(inferStateFromName("Thyme, fresh")).toBe("raw")
    expect(inferStateFromName("Basil, fresh")).toBe("raw")
  })
})

describe("regression: generic descriptor words no longer count as unexplained extra content", () => {
  it("does not penalize USDA's own classificatory prefix words (spices/seed)", () => {
    // Found live: adding "spices"/"seed" here fixed a REGRESSION the core-identity mechanism
    // itself introduced — cumin and coriander, both previously correct via USDA's "Spices, X
    // seed" naming convention, were pushed to an unnecessary LLM fallback because "spices"/"seed"
    // weren't recognized as generic classificatory words, not a different food.
    const cumin = coreIdentityScoreAdjustment("cumin", "cumin", "Spices, cumin seed")
    const coriander = coreIdentityScoreAdjustment("coriander", "coriander", "Spices, coriander seed")
    expect(cumin).toBeGreaterThanOrEqual(0)
    expect(coriander).toBeGreaterThanOrEqual(0)
  })
})

describe("regression: qualified-water and reversed-order dairy mismatches found in the structural-fix live audit", () => {
  it("rejects plain water matching coconut water", () => {
    // Found live: "Wasser" (plain water) matched BLS's "Kokoswasser (Fruchtwasser)" — coconut
    // water, a real product with meaningful sugar/calories. coreIdentityConflict alone can't
    // catch this since "wasser" is genuinely a substring of the German compound.
    expect(findMismatch("Wasser", "Kokoswasser (Fruchtwasser)")).not.toBeNull()
  })

  it("rejects cream matching USDA's reversed-order \"Cheese, cream\" (cream cheese)", () => {
    // Found live: "Sahne" (liquid cream) matched USDA's "Cheese, cream" — cream cheese, a solid/
    // spreadable dairy product, via USDA's "Cheese, <descriptor>" naming convention which puts
    // the category word first (the reverse of the English "cream cheese" the original marker
    // only matched in forward order).
    expect(categoryConflict("dairy", "Cheese, cream")).toBe(true)
  })

  it("rejects red onion matching a chutney/relish/preserve product", () => {
    // Found live: "Rote Zwiebel" (raw red onion) scored 33/100 against OFF's "Red onion
    // chutney" — just above MIN_ACCEPTABLE_SCORE (30) even with the core-identity penalty
    // applied, because "chutney" wasn't recognized as a composite/preserved-condiment marker.
    expect(categoryConflict("vegetable", "Red onion chutney")).toBe(true)
  })

  it("rejects red lentil matching red lentil PASTA (fusilli) via the strengthened extra-word penalty", () => {
    // Found live: "Rote Linse" (red lentil) still scored 33/100 against OFF's "Red lentil
    // fusilli" after the previous round's -30/extra-word penalty — a strong textual/modifier
    // match plus only ONE unexplained word ("fusilli") wasn't quite enough. Verifies the
    // strengthened -35/word penalty (a general recalibration, not a "fusilli" word-list entry)
    // pushes this below MIN_ACCEPTABLE_SCORE.
    const ranked = rankCandidates("red lentil", null, [{ name: "Red lentil fusilli", brand: null, hasCompleteNutrients: true, foodType: "simple" as const }], { queryCoreFood: "lentil" })
    expect(ranked[0].score).toBeLessThan(MIN_ACCEPTABLE_SCORE)
  })

  it("rejects cream matching a powdered cream substitute — \"powder\" is not globally generic", () => {
    // Found live: after adding "powder"/"powdered" to GENERIC_DESCRIPTOR_WORDS to fix
    // Knoblauchpulver, "Sahne" (liquid cream) started matching USDA's "Cream substitute,
    // powdered" — powder-vs-liquid is exactly the kind of form difference that should count as
    // unexplained extra content for a plain "cream" query, which never asked for powdered form.
    const adj = coreIdentityScoreAdjustment("cream", "cream", "Cream substitute, powdered")
    expect(adj).toBeLessThan(0)
  })

  it("still does not penalize a query's OWN powder/dried-form modifier (Knoblauchpulver/garlic powder)", () => {
    // The fix above works specifically because "powder" is part of the QUERY's own text here and
    // gets credited as a matched modifier — it never needed to be globally generic.
    const adj = coreIdentityScoreAdjustment("garlic", "garlic powder", "Spices, garlic powder")
    expect(adj).toBeGreaterThanOrEqual(0)
  })
})

describe("tokenize — German umlaut handling (regression for the NFKD-corruption bug)", () => {
  it("keeps an umlaut word as one coherent, transliterated token", () => {
    expect(tokenize("Gewürz")).toEqual(["gewuerz"])
    expect(tokenize("Öl")).toEqual(["oel"])
    expect(tokenize("grüne")).toEqual(["gruene"])
    expect(tokenize("Frühlingszwiebel")).toEqual(["fruehlingszwiebel"])
    expect(tokenize("Hähnchen")).toEqual(["haehnchen"])
    expect(tokenize("Käse")).toEqual(["kaese"])
  })

  it("never splits an umlaut word into fragments the way NFKD-then-strip did", () => {
    // The bug produced ["gewu", "rz"] for "Gewürz", ["o", "l"] for "Öl", etc.
    expect(tokenize("Gewürz")).not.toEqual(["gewu", "rz"])
    expect(tokenize("Öl")).not.toEqual(["o", "l"])
    expect(tokenize("Käse")).not.toEqual(["ka", "se"])
  })

  it("still correctly compares an umlaut word against its own compound (German right-headed compounding)", () => {
    expect(tokenize("Olivenöl")).toEqual(["olivenoel"])
    expect(tokenize("Olivenöl")[0]).toContain(tokenize("Öl")[0])
  })
})

describe("coreIdentityConflict — PRIMARY structural signal: core food noun must be present", () => {
  it("rejects a candidate whose name contains none of the query's core tokens, regardless of shared adjectives", () => {
    // Generalizes across every "Italian X" collision found live (Salami/Italian Ice/Creamy
    // Italian dressing/Focaccia, Italian/Pastry, Italian with cheese) without listing any of them
    // by name — none of these candidate names contain "seasoning" at all.
    expect(coreIdentityConflict("seasoning", "Salami, Italian, pork")).toBe(true)
    expect(coreIdentityConflict("seasoning", "Italian Ice")).toBe(true)
    expect(coreIdentityConflict("seasoning", "Creamy Italian dressing")).toBe(true)
    expect(coreIdentityConflict("seasoning", "Focaccia, Italian, plain")).toBe(true)
    expect(coreIdentityConflict("seasoning", "Pastry, Italian, with cheese")).toBe(true)
  })

  it("allows a candidate whose name DOES contain the core token", () => {
    expect(coreIdentityConflict("seasoning", "Italian Seasoning")).toBe(false)
  })

  it("rejects chili flakes matching onion flakes — different core food, shared form word only", () => {
    expect(coreIdentityConflict("chili", "Onions, dehydrated flakes")).toBe(true)
    expect(coreIdentityConflict("chili", "Chili, vegetarian")).toBe(false)
  })

  it("handles German compounding via substring containment, not exact token equality", () => {
    // "Speisezwiebel" is one fused token; a core of "Zwiebel" must still be recognized inside it.
    expect(coreIdentityConflict("Zwiebel", "Speisezwiebel roh")).toBe(false)
    expect(coreIdentityConflict("Knoblauch", "Knoblauch roh")).toBe(false)
  })

  it("is permissive when the core is null/empty (LLM disabled/failed) — never blocks everything", () => {
    expect(coreIdentityConflict(null, "Anything At All")).toBe(false)
    expect(coreIdentityConflict("", "Anything At All")).toBe(false)
  })

  it("does not reject on a coincidentally-short core token via substring noise (min length guard)", () => {
    // A 1-2 letter "core" (malformed LLM output) is too risky to substring-match — permissive.
    expect(coreIdentityConflict("a", "Completely Unrelated Product")).toBe(false)
  })
})

describe("coreIdentityScoreAdjustment — SECONDARY signal: penalize unexplained extra candidate content", () => {
  it("penalizes a candidate with one unexplained extra word enough to matter", () => {
    // "Tapioca Garlic" for bare "garlic" — one unexplained word ("tapioca").
    const adj = coreIdentityScoreAdjustment("garlic", "garlic", "Tapioca Garlic")
    expect(adj).toBeLessThan(0)
  })

  it("penalizes a candidate with two unexplained extra words more heavily than one", () => {
    const oneExtra = coreIdentityScoreAdjustment("onion", "red onion", "Red onion chutney")
    const twoExtra = coreIdentityScoreAdjustment("bell pepper", "green bell pepper", "Bell Pepper with Blue cheese")
    expect(twoExtra).toBeLessThan(oneExtra)
  })

  it("does not penalize generic quality/state descriptors as unexplained extras", () => {
    const adj = coreIdentityScoreAdjustment("pepper", "red bell pepper", "Peppers, sweet, red, raw")
    // "sweet" and "raw" are generic descriptors, "red" is the query's own modifier — no real penalty expected.
    expect(adj).toBeGreaterThanOrEqual(0)
  })

  it("rewards modifier overlap", () => {
    const withModifier = coreIdentityScoreAdjustment("onion", "red onion", "Red onion")
    const withoutModifier = coreIdentityScoreAdjustment("onion", "red onion", "Onion")
    expect(withModifier).toBeGreaterThanOrEqual(withoutModifier)
  })

  it("returns 0 (no adjustment) when core is unavailable", () => {
    expect(coreIdentityScoreAdjustment(null, "anything", "Anything Product")).toBe(0)
  })
})

describe("rankCandidates — end-to-end core-identity behavior (all residual live failures from the manual audit)", () => {
  function candidate(name: string, overrides: Record<string, unknown> = {}) {
    return { name, brand: null, hasCompleteNutrients: true, foodType: "simple" as const, ...overrides }
  }

  it("Italian seasoning != Italian pastry", () => {
    const ranked = rankCandidates("Italian seasoning", null, [candidate("Pastry, Italian, with cheese")], { queryCoreFood: "seasoning" })
    expect(ranked[0].mismatchReason).toMatch(/core identity conflict/)
    expect(ranked[0].score).toBeLessThan(MIN_ACCEPTABLE_SCORE)
  })

  it("Italian seasoning != Italian Ice", () => {
    const ranked = rankCandidates("Italian seasoning", null, [candidate("Italian Ice")], { queryCoreFood: "seasoning" })
    expect(ranked[0].mismatchReason).toMatch(/core identity conflict/)
  })

  it("Italian seasoning != an unrelated dressing, unless the query itself is a dressing", () => {
    const ranked = rankCandidates("Italian seasoning", null, [candidate("Creamy Italian dressing")], { queryCoreFood: "seasoning" })
    expect(ranked[0].mismatchReason).toMatch(/core identity conflict/)

    const dressingQuery = rankCandidates("Italian dressing", null, [candidate("Creamy Italian dressing")], { queryCoreFood: "dressing" })
    expect(dressingQuery[0].mismatchReason).toBeNull()
  })

  it("chili flakes != onion flakes", () => {
    const ranked = rankCandidates("chili flakes", null, [candidate("Onions, dehydrated flakes")], { queryCoreFood: "chili" })
    expect(ranked[0].mismatchReason).toMatch(/core identity conflict/)
  })

  it("dried basil != a pineapple/basil-branded product with a dominant unrelated word", () => {
    const ranked = rankCandidates("dried basil", null, [candidate("Mr Basil pineapple")], { queryCoreFood: "basil" })
    // core is present ("basil"), so this isn't a hard core-identity rejection — but "mr"/"pineapple"
    // are unexplained extra content that must drag the score below acceptance.
    expect(ranked[0].score).toBeLessThan(MIN_ACCEPTABLE_SCORE)
  })

  it("garlic != an unrelated garlic-containing composite product (Tapioca Garlic)", () => {
    const ranked = rankCandidates("garlic", null, [candidate("Tapioca Garlic")], { queryCoreFood: "garlic" })
    expect(ranked[0].score).toBeLessThan(MIN_ACCEPTABLE_SCORE)
  })

  it("green pepper != a pepper-and-cheese appetizer product", () => {
    const ranked = rankCandidates("green bell pepper", null, [candidate("Bell Pepper with Blue cheese")], { queryCoreFood: "bell pepper" })
    expect(ranked[0].score).toBeLessThan(MIN_ACCEPTABLE_SCORE)
  })

  it("vegetable broth != a vague generic \"Vegetable\" product", () => {
    const ranked = rankCandidates("vegetable broth", null, [candidate("Vegetable")], { queryCoreFood: "broth" })
    expect(ranked[0].mismatchReason).toMatch(/core identity conflict/)
  })

  it("positive control: a genuinely correct match still clears acceptance with core-identity data present", () => {
    const ranked = rankCandidates("Italian seasoning", null, [candidate("Italian Seasoning")], { queryCoreFood: "seasoning" })
    expect(ranked[0].mismatchReason).toBeNull()
    expect(ranked[0].score).toBeGreaterThanOrEqual(MIN_ACCEPTABLE_SCORE)
  })

  it("positive control: bell pepper still matches its correct USDA candidate (core token present via stemmed containment)", () => {
    const ranked = rankCandidates("red bell pepper", null, [candidate("Peppers, sweet, red, raw", { dataType: "SR Legacy" })], { queryCoreFood: "bell pepper" })
    expect(ranked[0].mismatchReason).toBeNull()
    expect(ranked[0].score).toBeGreaterThanOrEqual(MIN_ACCEPTABLE_SCORE)
  })
})

describe("rankCandidates — identity evidence is required before name-independent bonuses can accept (H2 regression)", () => {
  // Found in final review, confirmed by executing the real function: score is
  //   nameSimilarity*60 + coreAdjustment + brandAdjustment + (complete ? 15 : -50) + dataTypeScore
  // The last two are name-INDEPENDENT and sum to 35 for a candidate with complete nutrients in a
  // Foundation dataset — above MIN_ACCEPTABLE_SCORE (30) — so a candidate whose name has nothing
  // whatsoever in common with the query was accepted, with mismatchReason null, whenever no
  // core-identity signal was available. That is precisely the degraded path taken when the
  // whole-recipe LLM classification fails or is disabled (deterministic fallback sets
  // coreFoodEnglish=null and foodType="unknown" for every ingredient), i.e. the mode in which the
  // primary semantic gates are already gone.
  const dataTypeScore = (dt: string | null | undefined) =>
    dt === "Foundation" ? 20 : dt === "SR Legacy" ? 15 : dt === "Survey (FNDDS)" ? 10 : 0

  const unrelated = {
    name: "Beef, chuck, arm pot roast",
    brand: null,
    hasCompleteNutrients: true,
    dataType: "Foundation",
    foodType: "simple" as const,
  }

  it("rejects a zero-similarity candidate when no core-identity signal is available (LLM-classification-down path)", () => {
    expect(nameSimilarity("Petersilie", unrelated.name)).toBe(0)

    const ranked = rankCandidates("Petersilie", null, [unrelated], {
      queryState: "unknown", queryCategory: null, queryFoodType: "unknown", queryCoreFood: null, dataTypeScore,
    })

    expect(ranked[0].mismatchReason).toMatch(/no identity evidence/)
    expect(ranked[0].score).toBeLessThan(MIN_ACCEPTABLE_SCORE)
  })

  it("still accepts a legitimate match that has a core token but ZERO whole-token overlap", () => {
    // The guard must key off identity EVIDENCE, not off nameSimilarity alone. "bell pepper" vs
    // USDA's real "Peppers, sweet, raw" shares no exact token ("pepper" != "peppers") and neither
    // flattened string contains the other, so nameSimilarity is exactly 0 — yet the core token
    // "pepper" IS present inside "peppers", and this is the correct match. Rejecting on
    // similarity alone would regress the whole bell-pepper family, which resolves this way live.
    const bellPepper = {
      name: "Peppers, sweet, raw",
      brand: null,
      hasCompleteNutrients: true,
      dataType: "SR Legacy",
      foodType: "simple" as const,
    }
    expect(nameSimilarity("bell pepper", bellPepper.name)).toBe(0)

    const ranked = rankCandidates("bell pepper", null, [bellPepper], {
      queryState: "unknown", queryCategory: "vegetable", queryFoodType: "simple", queryCoreFood: "bell pepper", dataTypeScore,
    })

    expect(ranked[0].mismatchReason).toBeNull()
    expect(ranked[0].score).toBeGreaterThanOrEqual(MIN_ACCEPTABLE_SCORE)
  })

  it("does not fire when there is any real textual overlap", () => {
    const related = { name: "Parsley, fresh", brand: null, hasCompleteNutrients: true, dataType: "SR Legacy", foodType: "simple" as const }
    const ranked = rankCandidates("parsley", null, [related], {
      queryState: "unknown", queryCategory: null, queryFoodType: "unknown", queryCoreFood: null, dataTypeScore,
    })
    expect(ranked[0].mismatchReason).toBeNull()
  })
})

describe("cachedMatchConflict — re-validates a cache hit against the current query context (M2)", () => {
  // provider_match_cache is keyed by query text (+state/route/brand), deliberately not by
  // category/foodType/coreFood. Those gate acceptance but are free-text LLM output, so folding
  // them into the key would fragment the cache instead of protecting it. They are re-checked here
  // against the stored candidate for free, because a cache hit otherwise bypasses every semantic
  // gate — resolveNutrients only re-checks nutrient plausibility.
  it("rejects a cached match whose product name lacks this query's core identity", () => {
    const reason = cachedMatchConflict(
      { productName: "Onions, dehydrated flakes", foodType: "simple" },
      { foodName: "chili flakes", category: "spice", foodType: "simple", coreFood: "chili" },
    )
    expect(reason).toMatch(/core identity conflict on cached match/)
  })

  it("rejects a cached composite-dish match for a simple query", () => {
    const reason = cachedMatchConflict(
      { productName: "Lentil soup", foodType: "composite_dish" },
      { foodName: "red lentil", category: "legume", foodType: "simple", coreFood: "lentil" },
    )
    expect(reason).toMatch(/food type conflict on cached match/)
  })

  it("rejects a cached match that the curated mismatch rules would now reject", () => {
    const reason = cachedMatchConflict(
      { productName: "Dr pepper", foodType: "simple" },
      { foodName: "pepper", category: "spice", foodType: "simple", coreFood: "pepper" },
    )
    expect(reason).toMatch(/obvious mismatch on cached match/)
  })

  it("accepts a cached match that is still valid for this context", () => {
    expect(
      cachedMatchConflict(
        { productName: "Spices, parsley, dried", foodType: "simple" },
        { foodName: "dried parsley", category: "herb", foodType: "simple", coreFood: "parsley" },
      ),
    ).toBeNull()
  })

  it("is permissive when the signal is unavailable (no stored product name, or no core)", () => {
    expect(cachedMatchConflict({ productName: null }, { foodName: "x", category: null, foodType: "unknown", coreFood: null })).toBeNull()
    expect(
      cachedMatchConflict({ productName: "Anything At All", foodType: "unknown" }, { foodName: "x", category: null, foodType: "unknown", coreFood: null }),
    ).toBeNull()
  })
})

// Found live: "Gewürzpaste" (a vegetable-bouillon paste) resolved to USDA "Spices, allspice,
// ground" — core "spice" was satisfied by substring containment inside "spices"/"allspice", and
// with zero name similarity the candidate still reached exactly MIN_ACCEPTABLE_SCORE. English does
// not fuse identity the way German compounds do, so English core evidence now requires a whole
// token (plus regular s/es plurals), and a classificatory GENERIC_DESCRIPTOR token can never BE
// the evidence — USDA prefixes entire families with "Spices, …"/"Herbs, …".
describe("English core identity: whole-token evidence", () => {
  const conflict = (core: string, name: string) => coreIdentityConflict(core, name, "token")

  it("rejects the superstring class that caused the live wrong identity", () => {
    expect(conflict("spice", "Spices, allspice, ground")).toBe(true)
    expect(conflict("corn", "Acorn squash, raw")).toBe(true)
    expect(conflict("rice", "Liquorice, candy")).toBe(true)
    expect(conflict("mint", "Peppermints, hard candy")).toBe(true)
  })

  it("still accepts regular singular/plural pairs", () => {
    expect(conflict("tomato", "Tomatoes, raw")).toBe(false)
    expect(conflict("onion", "Onions, raw")).toBe(false)
    expect(conflict("carrot", "Carrots, frozen, unprepared")).toBe(false)
    expect(conflict("red lentil", "Lentils, raw")).toBe(false)
    expect(conflict("spring onion", "Onions, raw")).toBe(false)
  })

  it("a generic classificatory token is never itself the identity evidence", () => {
    // the family prefix must not stand in for the food
    expect(conflict("spice", "Spices, cumin seed")).toBe(true)
    expect(conflict("herb", "Herbs, basil, fresh")).toBe(true)
    expect(conflict("seed", "Spices, coriander seed")).toBe(true)
  })

  it("but a candidate is never rejected merely for CONTAINING a generic descriptor", () => {
    expect(conflict("cumin", "Spices, cumin seed")).toBe(false)
    expect(conflict("basil", "Herbs, basil, fresh")).toBe(false)
    expect(conflict("coriander", "Spices, coriander seed")).toBe(false)
    expect(conflict("oregano", "Spices, oregano, dried")).toBe(false)
    expect(conflict("parsley", "Spices, parsley, dried")).toBe(false)
  })

  it("leaves German compound matching untouched", () => {
    for (const [core, name] of [["Zwiebel", "Speisezwiebel roh"], ["Brühe", "Gemüsebrühe"],
                                ["Knoblauch", "Knoblauch roh"], ["Tomaten", "Tomatenmark"]] as const) {
      expect(coreIdentityConflict(core, name, "compound"), `${core}/${name}`).toBe(false)
    }
  })
})
