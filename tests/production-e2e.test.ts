import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest"
import { config } from "../src/config.js"
import { initCache } from "../src/utils/cache.js"
import { recipe, runPipeline, row, type ClassificationStub, type E2EOptions } from "./helpers/e2e-pipeline.js"

/**
 * The failures below were all observed on the DEPLOYED main branch, and every one of them had a
 * green provider-level test at the time. They are reproduced here through the whole pipeline —
 * raw Mealie name, batch normalization, attributes, routing, gates, rerank, provenance — because
 * that is the only layer at which they were ever visible.
 *
 * The classifications are what the real normalizer returned in production, including the parts
 * that caused the bugs: plural German cores, canonical names that drop a qualifier, and so on.
 */
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

/** The USDA page that actually won in production, recorded verbatim. */
const USDA_BEANS = {
  "canned kidney beans": [
    { fdcId: 2707379, description: "Kidney beans, NFS", dataType: "Survey (FNDDS)", foodCategory: "Beans, peas, legumes", foodNutrients: kcal(177, 6.97) },
    { fdcId: 175198, description: "Beans, kidney, red, mature seeds, canned, drained solids", dataType: "SR Legacy", foodCategory: "Legumes and Legume Products", foodNutrients: kcal(124, 0.5) },
  ],
}

/** One ingredient, classified the way production classified it. */
async function one(
  food: string, quantity: number, unit: string | null, c: Omit<ClassificationStub, "index">, options: E2EOptions = {},
) {
  const result = await runPipeline(recipe("probe", 1, [[quantity, unit, food]]), {
    classifications: [{ index: 0, ...c }],
    ...options,
  })
  return row(result, food)
}

describe("CRITICAL: canned kidney beans reach the BLS canned record", () => {
  it("resolves to the drained BLS record, not USDA's prepared survey entry", async () => {
    // The production classification, verbatim. The PLURAL core is the whole bug: the German
    // core-identity gate could not join "Kidneybohnen" to BLS's "Kidneybohne", rejected every
    // kidney-bean record outright, and BLS reported a miss. 400 g then resolved to USDA's
    // "Kidney beans, NFS" — a prepared entry carrying ~7 g/100 g of added cooking fat — for
    // 708 kcal instead of 512.
    const r = await one("Kidneybohnen a. d. Dose", 400, "Gramm", {
      canonicalGerman: "Kidneybohnen aus der Dose",
      canonicalEnglish: "canned kidney beans",
      coreFoodGerman: "Kidneybohnen",
      coreFoodEnglish: "kidney beans",
      preservation: "canned",
      category: "legume",
      foodType: "processed_single_food",
    }, { usda: USDA_BEANS })

    expect(r.provider).toBe("bls")
    expect(r.productName).toMatch(/Konserve/)
    expect(r.productName).not.toMatch(/NFS/)
    expect(r.kcalPer100g!).toBeLessThan(200)
    expect(r.kcalContribution).toBeGreaterThan(450)
    expect(r.kcalContribution).toBeLessThan(560)
  })

  it("holds for every inflection of the core the classifier might return", async () => {
    // The gate must not depend on which grammatical form the model happened to pick.
    for (const core of ["Kidneybohne", "Kidneybohnen", "Bohne", "Bohnen"]) {
      const r = await one("Kidneybohnen a. d. Dose", 400, "Gramm", {
        canonicalGerman: "Kidneybohnen aus der Dose", canonicalEnglish: "canned kidney beans",
        coreFoodGerman: core, coreFoodEnglish: "kidney beans",
        preservation: "canned", category: "legume", foodType: "processed_single_food",
      }, { usda: USDA_BEANS })
      expect(r.provider, core).toBe("bls")
      expect(r.productName, core).toMatch(/Konserve/)
    }
  })

  it("German plural cores resolve generally, not just for beans", async () => {
    // The same hard gate silently did this to any pluralised ingredient.
    const cases: [string, string, string, RegExp][] = [
      ["Tomaten", "Tomaten", "tomatoes", /Tomate/],
      ["Zwiebeln", "Zwiebeln", "onions", /zwiebel/i],
      ["Karotten", "Karotten", "carrots", /Karotte|Möhre/],
    ]
    for (const [food, core, en, expected] of cases) {
      const r = await one(food, 100, "Gramm", {
        canonicalGerman: food, canonicalEnglish: en, coreFoodGerman: core, coreFoodEnglish: en,
        state: "raw", category: "vegetable",
      })
      expect(r.provider, food).toBe("bls")
      expect(r.productName ?? "", food).toMatch(expected)
    }
  })
})

describe("previously-correct behaviour is preserved end to end", () => {
  const cases: [string, Omit<ClassificationStub, "index">, RegExp | null][] = [
    ["Ghee", { canonicalGerman: "Ghee", canonicalEnglish: "ghee", coreFoodGerman: "Ghee", coreFoodEnglish: "ghee", category: "fat" }, /Butterschmalz/],
    ["Nudeln", { canonicalGerman: "Nudeln", canonicalEnglish: "pasta", coreFoodGerman: "Nudeln", coreFoodEnglish: "pasta", state: "raw", category: "grain" }, /Teigwaren/],
    ["Basmati-Reis", { canonicalGerman: "Basmati-Reis", canonicalEnglish: "basmati rice", coreFoodGerman: "Reis", coreFoodEnglish: "rice", state: "raw", category: "grain" }, /Reis/],
    ["Hähnchenbrust", { canonicalGerman: "Hähnchenbrust", canonicalEnglish: "chicken breast", coreFoodGerman: "Hähnchenbrust", coreFoodEnglish: "chicken breast", state: "raw", category: "meat" }, /Brustfilet/],
    ["Ingwer frisch", { canonicalGerman: "Ingwer, frisch", canonicalEnglish: "fresh ginger", coreFoodGerman: "Ingwer", coreFoodEnglish: "ginger", state: "raw", preservation: "fresh", category: "spice" }, /Ingwer/],
  ]

  it.each(cases)("%s still resolves to the right BLS record", async (food, c, expected) => {
    const r = await one(food, 100, "Gramm", c)
    expect(r.provider, food).toBe("bls")
    if (expected) expect(r.productName ?? "", food).toMatch(expected)
  })

  it("pasta never becomes rice noodles", async () => {
    const r = await one("Nudeln", 300, "Gramm", {
      canonicalGerman: "Nudeln", canonicalEnglish: "pasta", coreFoodGerman: "Nudeln",
      coreFoodEnglish: "pasta", state: "raw", category: "grain",
    })
    expect(r.productName ?? "").not.toMatch(/Reisnudeln/)
  })

  it("ambiguous coriander never silently becomes coriander seed", async () => {
    const r = await one("Koriander", 10, "Gramm", {
      canonicalGerman: "Koriander", canonicalEnglish: "coriander", coreFoodGerman: "Koriander",
      coreFoodEnglish: "coriander", category: "herb",
    }, {
      usda: { coriander: [
        { fdcId: 170922, description: "Spices, coriander seed", dataType: "SR Legacy", foodCategory: "Spices and Herbs", foodNutrients: kcal(298, 17.8) },
        { fdcId: 169997, description: "Coriander (cilantro) leaves, raw", dataType: "SR Legacy", foodCategory: "Vegetables and Vegetable Products", foodNutrients: kcal(23, 0.5) },
      ] },
    })
    expect(r.productName ?? "").not.toMatch(/seed/i)
  })

  it("a garlic seasoning never becomes a raw clove", async () => {
    const r = await one("Knoblauchgewürz", 4, "Gramm", {
      canonicalGerman: "Knoblauchgewürz", canonicalEnglish: "garlic seasoning",
      coreFoodGerman: "Knoblauch", coreFoodEnglish: "garlic", category: "seasoning",
    }, {
      usda: { "garlic seasoning": [
        { fdcId: 1104647, description: "Garlic, raw", dataType: "Foundation", foodCategory: "Vegetables and Vegetable Products", foodNutrients: kcal(143, 0.5) },
      ] },
    })
    expect(r.productName ?? "").not.toMatch(/^Garlic, raw|^Knoblauch roh/)
  })
})

describe("recipe arithmetic and originalText isolation hold end to end", () => {
  it("divides by servings exactly once and never reads originalText", async () => {
    const result = await runPipeline(recipe("arith", 2, [[100, "Gramm", "Zwiebel"], [100, "Gramm", "Tomate"]]), {
      classifications: [
        { index: 0, canonicalGerman: "Zwiebel", canonicalEnglish: "onion", coreFoodGerman: "Zwiebel", coreFoodEnglish: "onion", state: "raw", category: "vegetable" },
        { index: 1, canonicalGerman: "Tomate", canonicalEnglish: "tomato", coreFoodGerman: "Tomate", coreFoodEnglish: "tomato", state: "raw", category: "vegetable" },
      ],
    })
    const summed = result.rows.reduce((a, r) => a + r.kcalContribution, 0)
    expect(result.totalKcal).toBeCloseTo(summed, 6)
    expect(result.perServingKcal).toBeCloseTo(result.totalKcal / 2, 0)
    // The stale originalText claims a different quantity and a brand; neither may appear.
    for (const r of result.rows) expect(r.grams).toBe(100)
  })
})

describe("production matching failures observed on the deployed branch", () => {
  const USDA_CHILI = {
    "red chili peppers": [
      { fdcId: 170108, description: "Peppers, sweet, red, raw", dataType: "SR Legacy", foodCategory: "Vegetables and Vegetable Products", foodNutrients: kcal(31, 0.3) },
    ],
  }

  it("A: pickle brine never becomes cucumber juice — a shared source is not a shared product", async () => {
    // Production reranked this to BLS "Gemüsesaft aus Gurke" at 0.9 confidence, reasoning "both are
    // derived from cucumbers". Brine and juice are different derived-product classes.
    const r = await one("Gurkenwasser", 20, "Milliliter", {
      canonicalGerman: "Gurkenwasser", canonicalEnglish: "cucumber water",
      coreFoodGerman: "Gurke", coreFoodEnglish: "cucumber", category: "liquid",
    }, { rerank: () => '{"selected":1,"confidence":0.9,"reason":"both derived from cucumbers"}' })
    expect(r.productName ?? "").not.toMatch(/saft|juice/i)
    expect(r.productName ?? "").not.toMatch(/Gurke roh|Cucumber, raw/)
  })

  it("B: an explicit light claim is never silently dropped", async () => {
    const r = await one("Mayo Light", 12, "Gramm", {
      canonicalGerman: "Mayonnaise, leicht", canonicalEnglish: "light mayonnaise",
      coreFoodGerman: "Mayonnaise", coreFoodEnglish: "mayonnaise", category: "condiment",
      foodType: "processed_single_food",
    })
    // BLS has no light mayonnaise, so a match is still allowed — but it must say so.
    if (r.provider === "bls") expect(r.productName).toBeTruthy()
    expect(r.confidence!).toBeLessThanOrEqual(0.7)
  })

  it("C: the reranker may not swap one unsupported subtype for another", async () => {
    // Production moved "Senf" from "Senf mittelscharf" to "Senf scharf" — identical nutrition,
    // identical stripped identity — for no reason a user could act on.
    const r = await one("Senf", 4, "Gramm", {
      canonicalGerman: "Senf", canonicalEnglish: "mustard", coreFoodGerman: "Senf",
      coreFoodEnglish: "mustard", category: "condiment", foodType: "processed_single_food",
    }, { rerank: (c) => `{"selected":${c.findIndex((x) => /scharf/.test(x) && !/mittel/.test(x)) + 1 || 1},"confidence":0.9,"reason":"same food type"}` })
    expect(r.productName ?? "").not.toMatch(/süß/)
    expect(r.llmReranked, `picked ${r.productName}`).toBe(false)
  })

  it("D: fried onions never resolve to raw onion", async () => {
    const r = await one("Röstzwiebel", 20, "Gramm", {
      canonicalGerman: "Röstzwiebeln", canonicalEnglish: "fried onions",
      coreFoodGerman: "Zwiebel", coreFoodEnglish: "onion", state: "cooked", category: "vegetable",
    })
    expect(r.productName ?? "").not.toBe("Speisezwiebel roh")
    if (r.provider === "bls") expect(r.productName).toMatch(/Röst/)
  })

  it("E: a chili never becomes a sweet pepper, even downstream of BLS", async () => {
    const r = await one("rote Chilischoten", 20, "Gramm", {
      canonicalGerman: "rote Chilischoten", canonicalEnglish: "red chili peppers",
      coreFoodGerman: "Chilischote", coreFoodEnglish: "chili pepper", state: "raw", category: "vegetable",
    }, { usda: USDA_CHILI, rerank: () => '{"selected":null,"confidence":0.95,"reason":"sweet pepper is not a chili"}' })
    expect(r.productName ?? "").not.toMatch(/sweet/i)
  })

  it("F: a lean claim BLS cannot answer is recorded rather than pretended away", async () => {
    const r = await one("mageres Rinderhackfleisch", 400, "Gramm", {
      canonicalGerman: "Rinderhackfleisch, mager", canonicalEnglish: "lean ground beef",
      coreFoodGerman: "Rinderhackfleisch", coreFoodEnglish: "ground beef", state: "raw", category: "meat",
    })
    // BLS files its lean mince as "Tatar", unreachable from this name — so the ordinary mince is
    // the honest answer, provided the dropped claim is visible.
    expect(r.provider).toBe("bls")
    expect(r.productName).toMatch(/Hackfleisch/)
    expect(r.confidence!).toBeLessThanOrEqual(0.7)
  })
})
