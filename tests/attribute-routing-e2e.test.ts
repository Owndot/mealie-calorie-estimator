import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest"
import { config } from "../src/config.js"
import { initCache, setCachedProviderMatch, getCachedProviderMatch, buildQueryKey, __clearProviderCachesForTests } from "../src/utils/cache.js"
import { recipe, runPipeline, row, type ClassificationStub, type E2EOptions } from "./helpers/e2e-pipeline.js"
import { MealieRecipeProvider, __resetRecipeIndexForTests } from "../src/services/providers/mealie-recipe-provider.js"
import { UNKNOWN_ATTRIBUTES, type ProviderMatch, type NutrientSet } from "../src/types.js"

/**
 * MATERIAL NUTRITIONAL ATTRIBUTES must steer provider selection, not merely annotate it.
 *
 * Production recognised that "mageres Rinderhackfleisch" and "Mayo Light" failed their explicit
 * reduced-fat claim — recorded it in unmetAttributes, capped confidence at 0.55 — and then used the
 * record anyway, because the chain stopped at the first provider that returned anything. At 400 g
 * the beef is ~35% of its recipe, so that is a calorie error, not a labelling one.
 */
/**
 * Mealie is mocked for the whole file. The recipe provider sits first in the chain and was
 * reaching for a real host on every single lookup, so each test logged an ENOTFOUND and paid a DNS
 * timeout for it. `served` starts empty, which is the same answer ("no such recipe") without the
 * network.
 */
const served: Record<string, unknown> = {}
vi.mock("../src/services/mealie-client.js", () => ({
  listRecipeNames: vi.fn(async () => Object.entries(served).map(([slug, r]) => ({ slug, name: (r as { name: string }).name }))),
  getRecipe: vi.fn(async (slug: string) => {
    if (!served[slug]) throw new Error(`404 ${slug}`)
    return served[slug]
  }),
  getRecipeHouseholdId: vi.fn(() => null),
  patchRecipe: vi.fn(async () => {}),
  getOrCreateTags: vi.fn(async () => []),
  getAllRecipes: vi.fn(async () => Object.keys(served)),
}))

beforeAll(async () => {
  await initCache()
})

beforeEach(() => {
  config.usda.retryBackoffMs = 1
  config.openFoodFacts.retryBackoffMs = 1
  vi.restoreAllMocks()
})

afterEach(() => {
  config.llm.enabled = false
  config.llm.apiKey = ""
})

const kcal = (v: number, fat = 0) => [
  { nutrientId: 1008, nutrientName: "Energy", unitName: "KCAL", value: v },
  { nutrientId: 1004, nutrientName: "Total lipid (fat)", unitName: "G", value: fat },
]

/** The real USDA pages for these queries, recorded verbatim. */
const USDA = {
  "lean ground beef": [
    { fdcId: 2514744, description: "Beef, ground", dataType: "Survey (FNDDS)", foodCategory: "Meat, Poultry, Fish", foodNutrients: kcal(261, 16.82) },
    { fdcId: 174032, description: "Beef, ground, 80% lean meat / 20% fat, raw", dataType: "SR Legacy", foodCategory: "Beef Products", foodNutrients: kcal(254, 20) },
    { fdcId: 174030, description: "Beef, ground, 75% lean meat / 25% fat, raw", dataType: "SR Legacy", foodCategory: "Beef Products", foodNutrients: kcal(293, 25) },
  ],
  "light mayonnaise": [
    { fdcId: 2345678, description: "Mayonnaise, light", dataType: "Survey (FNDDS)", foodCategory: "Fats and Oils", foodNutrients: kcal(238, 22.22) },
    { fdcId: 171015, description: "Salad dressing, mayonnaise, light", dataType: "SR Legacy", foodCategory: "Fats and Oils", foodNutrients: kcal(238, 22.2) },
  ],
  "cooking cream 15% fat": [],
}

async function one(
  food: string, quantity: number, unit: string | null, c: Omit<ClassificationStub, "index">, options: E2EOptions = {},
) {
  const result = await runPipeline(recipe("probe", 1, [[quantity, unit, food]]), {
    classifications: [{ index: 0, ...c }], ...options,
  })
  return { r: row(result, food), result }
}

describe("a stated nutritional attribute steers which provider is used", () => {
  it("light mayonnaise: skips BLS's full-fat record for USDA's actual light one", async () => {
    // BLS holds only "Mayonnaise (Fertigprodukt)" 750 kcal and "Salatmayonnaise" 490 — neither is
    // light. USDA holds "Mayonnaise, light" at 238. Identity is equally good in both; only the
    // attribute separates them.
    const { r } = await one("Mayo Light", 12, "Gramm", {
      canonicalGerman: "Mayonnaise, leicht", canonicalEnglish: "light mayonnaise",
      coreFoodGerman: "Mayonnaise", coreFoodEnglish: "mayonnaise",
      category: "condiment", foodType: "processed_single_food",
    }, { usda: USDA })

    // The complete provenance row. `unmetAttributes` empty is the load-bearing field: BLS's record
    // was kept as a shortfall carrying ["reduced-fat"], and the accepted USDA record must not
    // inherit it — a caveat that outlives the thing it was about is worse than none.
    expect({
      provider: r.provider, productName: r.productName, kcalPer100g: r.kcalPer100g,
      grams: r.grams, confidence: r.confidence, matchReason: r.matchReason,
      llmReranked: r.llmReranked, unmetAttributes: r.unmetAttributes,
      requestedFatPercent: r.requestedFatPercent,
    }).toEqual({
      provider: "usda", productName: "Mayonnaise, light", kcalPer100g: 238,
      grams: 12, confidence: 0.8, matchReason: "fuzzy",
      llmReranked: false, unmetAttributes: [], requestedFatPercent: null,
    })
    // A satisfied attribute means no caveat and no confidence cap.
    expect(r.confidence!).toBeGreaterThan(0.6)
  })

  it("lean ground beef: no provider satisfies it, so the LLM estimate of the full text wins", async () => {
    // Measured: BLS's mince is 224 kcal/16.4% fat and USDA's family tops out at 80/20 = 254/20% —
    // FATTIER than BLS. BLS's genuinely lean record is filed as "Tatar/Schabefleisch" (115 kcal,
    // 3% fat), a different product, and is deliberately not substituted. So nothing in either
    // database is lean mince, and the estimate made from the whole phrase is the better answer.
    //
    // 176 IS THIS STUB'S OWN NUMBER. It is what the line below tells the fake LLM to say, chosen as
    // a plausible figure for lean mince; no database was consulted for it and nothing in the system
    // verifies it. What the test asserts is the ROUTING — that the whole phrase including "mager"
    // reaches the estimator and its answer is used — not that lean mince is 176 kcal. The recorded
    // confidence says the same thing: 0.35, the floor for an estimate, against 0.85 for a database
    // record. Read any quoted 176 as "whatever the model answers here", never as a measurement.
    const { r } = await one("mageres Rinderhackfleisch", 400, "Gramm", {
      canonicalGerman: "Rinderhackfleisch, mager", canonicalEnglish: "lean ground beef",
      coreFoodGerman: "Rinderhackfleisch", coreFoodEnglish: "ground beef",
      state: "raw", category: "meat",
    }, { usda: USDA, llmNutrients: { "lean ground beef": { kcal: 176, protein: 20, carbs: 0, fat: 10 } } })

    // The complete provenance row, pinned field by field.
    expect({
      provider: r.provider, productName: r.productName, providerId: r.providerId,
      kcalPer100g: r.kcalPer100g, grams: r.grams, confidence: r.confidence,
      matchReason: r.matchReason, llmReranked: r.llmReranked, rerankReason: r.rerankReason,
      unmetAttributes: r.unmetAttributes, requestedFatPercent: r.requestedFatPercent,
    }).toEqual({
      provider: "llm-nutrient",
      // No record, because there is no record: an estimate names no database row, and saying so is
      // the point. Unknown is not zero and not a citation.
      productName: null, providerId: null,
      kcalPer100g: 176, grams: 400, confidence: 0.35,
      matchReason: null, llmReranked: false, rerankReason: null,
      // Empty because the estimate was made FROM the claim — there is nothing left unmet.
      unmetAttributes: [], requestedFatPercent: null,
    })
    expect(r.productName ?? "").not.toMatch(/Tatar|Schabefleisch/)
  })

  it("...and falls back to the flagged database record when nothing else can answer", async () => {
    // The chain is exhausted — USDA has nothing leaner and the estimate is unavailable — so the
    // best identity match still wins, and still says what it does not satisfy.
    const { r } = await one("mageres Rinderhackfleisch", 400, "Gramm", {
      canonicalGerman: "Rinderhackfleisch, mager", canonicalEnglish: "lean ground beef",
      coreFoodGerman: "Rinderhackfleisch", coreFoodEnglish: "ground beef",
      state: "raw", category: "meat",
    }, { usda: USDA })
    expect(r.provider).toBe("bls")
    expect(r.productName).toMatch(/Hackfleisch/)
    expect(r.unmetAttributes).toEqual(["reduced-fat"])
    expect(r.confidence!).toBeLessThanOrEqual(0.55)
  })

  it("cooking cream 15%: the percentage survives, and no nearby cream is substituted", async () => {
    // BLS's cream family has no 15% entry. Its neighbours are "Kaffeesahne mind. 10 % Fett" (124
    // kcal) and "Sauerrahm/Schmand, mind. 20 % Fett" (206) — and Schmand is SOURED, a different
    // product family. Interpolating across that boundary is not defensible, so the estimate stands.
    const { r } = await one("Kochsahne 15%", 500, "Gramm", {
      canonicalGerman: "Kochsahne 15 % Fett", canonicalEnglish: "cooking cream 15% fat",
      coreFoodGerman: "Sahne", coreFoodEnglish: "cream", fatPercent: 15,
      category: "dairy", foodType: "processed_single_food",
    }, { usda: USDA, llmNutrients: { "cooking cream 15% fat": { kcal: 150, protein: 3, carbs: 4, fat: 15 } } })

    expect(r.provider).toBe("llm-nutrient")
    expect(r.kcalPer100g).toBe(150)
    // The requested percentage must survive normalization all the way into provenance.
    expect(r.requestedFatPercent).toBe(15)
  })

  it("a full-fat cream record is never substituted for an explicit 15%", async () => {
    const { r } = await one("Kochsahne 15%", 500, "Gramm", {
      canonicalGerman: "Kochsahne 15 % Fett", canonicalEnglish: "cooking cream 15% fat",
      coreFoodGerman: "Sahne", coreFoodEnglish: "cream", fatPercent: 15,
      category: "dairy", foodType: "processed_single_food",
    })
    // Without an LLM this stays unresolved rather than becoming 30% whipping cream.
    expect(r.productName ?? "").not.toMatch(/Schlagsahne|30 %|36 %/)
  })
})

describe("a satisfied attribute is accepted immediately, without searching on", () => {
  it("stops at the first provider when the claim is met", async () => {
    const { r, result } = await one("Magerquark", 200, "Gramm", {
      canonicalGerman: "Magerquark", canonicalEnglish: "low-fat quark",
      coreFoodGerman: "Quark", coreFoodEnglish: "quark",
      category: "dairy", foodType: "processed_single_food",
    })
    if (r.provider === "bls") {
      expect(r.unmetAttributes ?? []).toEqual([])
      expect(result.llmCalls.nutrients).toBe(0)
    }
  })

  it("an ingredient with no stated claim is unaffected by any of this", async () => {
    const { r } = await one("Zwiebel", 100, "Gramm", {
      canonicalGerman: "Zwiebel", canonicalEnglish: "onion", coreFoodGerman: "Zwiebel",
      coreFoodEnglish: "onion", state: "raw", category: "vegetable",
    })
    expect(r.provider).toBe("bls")
    expect(r.unmetAttributes ?? []).toEqual([])
    expect(r.confidence!).toBeGreaterThanOrEqual(0.75)
  })
})

describe("recipe-level quality explains WHY a total is risky", () => {
  it("names the unmet attribute and the calorie share", async () => {
    const result = await runPipeline(recipe("salad", 3, [
      [400, "Gramm", "mageres Rinderhackfleisch"], [200, "Gramm", "Eisbergsalat"],
    ]), {
      classifications: [
        { index: 0, canonicalGerman: "Rinderhackfleisch, mager", canonicalEnglish: "lean ground beef", coreFoodGerman: "Rinderhackfleisch", coreFoodEnglish: "ground beef", state: "raw", category: "meat" },
        { index: 1, canonicalGerman: "Eisbergsalat", canonicalEnglish: "iceberg lettuce", coreFoodGerman: "Eisbergsalat", coreFoodEnglish: "lettuce", state: "raw", category: "vegetable" },
      ],
      usda: USDA,
    })
    expect(result.matchQuality).not.toBe("high")
    expect(result.matchQualityReason).toMatch(/mageres Rinderhackfleisch/)
    expect(result.matchQualityReason).toMatch(/% of the calories/)
    expect(result.matchQualityReason).toMatch(/does not satisfy the explicit reduced-fat attribute/)
  })
})

describe("cached provenance round-trips exactly", () => {
  // Production showed matchReason "llm-reranked" alongside llmReranked false. PR #7 added the
  // column, the write, the row type and the read-back call — but left `provenance` out of the
  // SELECT list, so row.provenance was always undefined and every cache HIT lost the fields.
  const nutrients: NutrientSet = {
    kcalPer100g: 304, proteinPer100g: 11, carbsPer100g: 64, fatPer100g: 3.3,
    saturatedFatPer100g: null, transFatPer100g: null, unsaturatedFatPer100g: null,
    fiberPer100g: null, sugarPer100g: null, sodiumPer100g: null, cholesterolPer100g: null,
  }

  it("preserves matchReason, llmReranked, rerankReason and unmetAttributes", () => {
    __clearProviderCachesForTests()
    const key = buildQueryKey("provenance-round-trip|unknown", null)
    const stored: ProviderMatch = {
      nutrients, canonicalName: "pepper", brand: null, state: "unknown", provider: "bls",
      providerId: "R211100", productName: "Pfeffer schwarz, getrocknet", confidence: 0.8,
      foodType: "simple", matchReason: "llm-reranked", llmReranked: true,
      rerankReason: "the only black pepper record", unmetAttributes: ["reduced-fat"],
    }
    setCachedProviderMatch("bls", key, stored)

    const read = getCachedProviderMatch("bls", key)
    expect(read).toBeDefined()
    expect(read!.matchReason).toBe("llm-reranked")
    expect(read!.llmReranked).toBe(true)
    expect(read!.rerankReason).toBe("the only black pepper record")
    expect(read!.unmetAttributes).toEqual(["reduced-fat"])
    // matchReason and llmReranked must never disagree — that pairing is the reported bug.
    expect(read!.matchReason === "llm-reranked").toBe(read!.llmReranked === true)
  })

  it("leaves an ordinary match's provenance empty rather than inventing it", () => {
    __clearProviderCachesForTests()
    const key = buildQueryKey("ordinary-match|unknown", null)
    setCachedProviderMatch("bls", key, {
      nutrients, canonicalName: "onion", brand: null, state: "raw", provider: "bls",
      providerId: "G480100", productName: "Speisezwiebel roh", confidence: 0.85,
      foodType: "simple", matchReason: "fuzzy",
    })
    const read = getCachedProviderMatch("bls", key)!
    expect(read.matchReason).toBe("fuzzy")
    expect(read.llmReranked).toBeUndefined()
    expect(read.unmetAttributes).toBeUndefined()
  })

  it("keeps a homemade-ingredient match out of the provider cache entirely", async () => {
    // `sourceRecipeSlug`/`sourceRecipeFingerprint` are NOT part of the cached provenance blob, and
    // must not need to be: the recipe provider reads the source recipe on every lookup and never
    // writes to provider_match_cache, so the fingerprint that invalidates a dependent recipe is
    // recomputed rather than remembered. This pins that, because caching such a match without
    // extending serializeProvenance would silently freeze a dependent recipe's nutrition at
    // whatever the source said the first time.
    __clearProviderCachesForTests()
    served["tikka-paste"] = {
      slug: "tikka-paste", name: "Tikka-Paste", recipeYield: "g", recipeYieldQuantity: 800,
      recipeServings: 1, recipeIngredient: [], tags: [], extras: null,
      nutrition: { calories: "2872.68" },
    }
    __resetRecipeIndexForTests()

    const match = await new MealieRecipeProvider().lookup({
      foodName: "tikka paste", structuredName: "Tikka-Paste", canonicalGerman: "Tikka-Paste",
      brand: null, state: "unknown", foodType: "simple", attributes: UNKNOWN_ATTRIBUTES,
    } as never)

    expect(match?.sourceRecipeSlug).toBe("tikka-paste")
    expect(match?.sourceRecipeFingerprint).toEqual(expect.any(String))
    expect(getCachedProviderMatch("mealie-recipe", buildQueryKey("tikka paste", null))).toBeUndefined()

    delete served["tikka-paste"]
    __resetRecipeIndexForTests()
  })
})

describe("the provenance written back to Mealie carries every attribute field", () => {
  // The provider cache is one hop; the extras blob on the recipe is the one a user (and the next
  // run) actually reads. requestedFatPercent and sourceRecipeSlug live only here — neither is a
  // ProviderMatch field — so this is the only place their survival can be asserted.
  it("emits matchReason, llmReranked, rerankReason, unmetAttributes, requestedFatPercent and sourceRecipeSlug", async () => {
    const result = await runPipeline(recipe("provenance-writeback", 2, [
      [400, "Gramm", "mageres Rinderhackfleisch"], [500, "Gramm", "Kochsahne 15%"],
    ]), {
      classifications: [
        { index: 0, canonicalGerman: "Rinderhackfleisch, mager", canonicalEnglish: "lean ground beef", coreFoodGerman: "Rinderhackfleisch", coreFoodEnglish: "ground beef", state: "raw", category: "meat" },
        { index: 1, canonicalGerman: "Kochsahne 15 % Fett", canonicalEnglish: "cooking cream 15% fat", coreFoodGerman: "Sahne", coreFoodEnglish: "cream", fatPercent: 15, category: "dairy", foodType: "processed_single_food" },
      ],
      usda: USDA,
      llmNutrients: { "cooking cream 15% fat": { kcal: 150, protein: 3, carbs: 4, fat: 15 } },
    })

    const beef = row(result, "mageres Rinderhackfleisch")
    expect(beef.unmetAttributes).toEqual(["reduced-fat"])
    expect(beef.matchReason).toBeTruthy()

    const cream = row(result, "Kochsahne 15%")
    expect(cream.requestedFatPercent).toBe(15)
    // An ingredient that states no percentage must report null, not 0 — "unknown" is not "zero".
    expect(beef.requestedFatPercent).toBeNull()
  })
})
