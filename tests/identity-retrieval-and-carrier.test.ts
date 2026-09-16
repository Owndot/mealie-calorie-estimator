import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest"
import { config } from "../src/config.js"
import { initCache } from "../src/utils/cache.js"
import { resolveIngredient, stubProviderResponses, type ResolvedRow } from "./helpers/resolve-fixture.js"
import { carrierConflict } from "../src/services/providers/food-semantics.js"
import { GENERIC_DESCRIPTOR_WORDS, sharesFullQueryIdentity } from "../src/services/providers/ranking.js"
import type { FixtureIngredient } from "./helpers/nutrition-fixtures.js"

/**
 * Two production failures whose causes turned out to be the same shape: something OTHER than the
 * query's own identity decided a hard gate.
 *
 * "Schwarze Bohne" — the live classifier produced canonicalEnglish "black bean" and
 * coreFoodEnglish "bean", both SINGULAR. USDA's local retrieval asked its token index for exact
 * membership, so the plural token the record actually carries ("Beans, black, mature seeds, raw")
 * was never asked for, and the retrieved pool differed from the plural spelling's by 209 records.
 * That pool contained exactly one leaf record — "Winged bean leaves, raw", which shares only the
 * word "bean" — and its presence made availablePlantParts() report seed AND leaf. The plant-part
 * ambiguity rule then hard-rejected every "…mature seeds…" record including the correct one; the
 * survivors topped out at score 10 (production logged exactly that), and 400 g of black beans
 * became a fabricated 132 kcal/100 g estimate. The plural spelling of the same ingredient
 * resolved correctly, so one letter decided a hard gate.
 *
 * "Gurkenwasser" — classified as "cucumber water", it resolved to USDA's "Water, bottled, generic"
 * at confidence 0.7. derivedProductConflict() was satisfied because both sides are the brine
 * class, the core gate was satisfied by the shared word "water", and nothing anywhere asked where
 * the cucumber went. The ingredient became 0 kcal plain water.
 *
 * Both are written against the REAL bundled databases and the real production classifications, so
 * a regression reads as "the rule stopped holding" rather than "one food changed".
 */
beforeAll(async () => {
  await initCache()
})

beforeEach(() => {
  config.openFoodFacts.retryBackoffMs = 1
  config.llm.enabled = false
  config.llm.apiKey = ""
  vi.restoreAllMocks()
  stubProviderResponses()
})

const ing = (
  name: string, de: string, en: string, coreDe: string, coreEn: string,
  extra: Partial<FixtureIngredient> = {},
): FixtureIngredient => ({
  name, canonicalGerman: de, canonicalEnglish: en, coreFoodGerman: coreDe, coreFoodEnglish: coreEn,
  grams: 100, state: "unknown", foodType: "simple", ...extra,
})

const describeRow = (r: ResolvedRow) => `${r.provider}/${r.productName ?? "—"}/${r.kcalPer100g ?? "—"}`

describe("retrieval must not decide identity by spelling", () => {
  // The exact production classification, transcribed from provenance. The logged topScore of 10 is
  // produced by this combination and no other, which is how the singular core was identified.
  const blackBeanSingular = ing("Schwarze Bohne", "Schwarze Bohne", "black bean", "Bohne", "bean", { category: "legume" })
  const blackBeanPlural = ing("Schwarze Bohnen", "Schwarze Bohnen", "black beans", "Bohne", "beans", { category: "legume" })

  it("the real production 'Schwarze Bohne' classification reaches a real black-bean record", async () => {
    const row = await resolveIngredient(blackBeanSingular)
    expect(row.provider).toBe("usda-local")
    expect(row.providerId).toBe("173734")
    expect(row.productName).toBe("Beans, black, mature seeds, raw")
    // The point of the fix: this used to be a fabricated estimate, not a record.
    expect(row.provider).not.toBe("llm-nutrient")
  })

  it("the singular and plural spellings of the same ingredient agree", async () => {
    const singular = await resolveIngredient(blackBeanSingular)
    const plural = await resolveIngredient(blackBeanPlural)
    expect(singular.providerId).toBe(plural.providerId)
    expect(singular.kcalPer100g).toBe(plural.kcalPer100g)
  })

  it("canned black beans stay distinguishable from the dry/raw record", async () => {
    const canned = await resolveIngredient(ing(
      "Schwarze Bohnen a. d. Dose", "Schwarze Bohnen, Konserve", "canned black beans", "Bohne", "bean",
      { category: "legume", attributes: { preservation: "canned" } },
    ))
    const raw = await resolveIngredient(blackBeanSingular)
    expect(canned.providerId).not.toBe(raw.providerId)
    expect(canned.productName).toMatch(/canned/i)
    // A canned bean has taken up water; it cannot carry a dry bean's energy density.
    expect(canned.kcalPer100g!).toBeLessThan(raw.kcalPer100g! / 2)
  })
})

describe("plant-part ambiguity is evidence about the queried food, not about the retrieved pool", () => {
  it("a record sharing only part of the query's identity is not ambiguity evidence", () => {
    // The whole black-bean failure in one assertion.
    expect(sharesFullQueryIdentity("black bean", "Beans, black, mature seeds, raw", "token")).toBe(true)
    expect(sharesFullQueryIdentity("black bean", "Winged bean leaves, raw", "token")).toBe(false)
    // …while a record that genuinely answers the whole question still counts.
    expect(sharesFullQueryIdentity("coriander", "Coriander (cilantro) leaves, raw", "token")).toBe(true)
    expect(sharesFullQueryIdentity("coriander", "Spices, coriander seed", "token")).toBe(true)
  })

  it("a bare 'Koriander' still refuses to guess between leaf and seed", async () => {
    const row = await resolveIngredient(ing("Koriander", "Koriander", "coriander", "Koriander", "coriander", { category: "herb" }))
    // Leaf 23 kcal vs seed 298 kcal: picking either would invent a fact the ingredient never gave.
    expect(describeRow(row)).not.toMatch(/coriander seed/i)
    expect(describeRow(row)).not.toMatch(/cilantro/i)
    // The LLM is off in these tests, so the honest "no database record" answer surfaces as
    // "unresolved"; in production, with an estimator available, it is "llm-nutrient".
    expect(row.provider).toBe("unresolved")
  })

  it("'gemahlener Koriander' names its form and still resolves to the seed record", async () => {
    const row = await resolveIngredient(ing(
      "gemahlener Koriander", "Koriander, gemahlen", "ground coriander", "Koriander", "coriander",
      { category: "spice", attributes: { form: "ground" } },
    ))
    expect(row.provider).toBe("usda-local")
    expect(row.providerId).toBe("170922")
    expect(row.productName).toBe("Spices, coriander seed")
  })
})

describe("a derived product must name what it was derived from", () => {
  it("'Gurkenwasser' no longer becomes generic bottled water", async () => {
    // The real production core, identified from the recorded confidence of 0.7: a null core is
    // capped at 0.55, so the classifier's core was non-empty and contained the word "water".
    const row = await resolveIngredient(ing(
      "Gurkenwasser", "Gurkenwasser", "cucumber water", "Gurke", "cucumber water",
      { category: "liquid", grams: 20 },
    ))
    expect(describeRow(row)).not.toMatch(/Water, bottled, generic/)
    expect(row.providerId).not.toBe("174158")
    // No database record, honestly reported — "unresolved" here, "llm-nutrient" in production.
    expect(row.provider).toBe("unresolved")
  })

  it("the same holds however the classifier splits the core", async () => {
    for (const core of ["cucumber water", "water", "cucumber"]) {
      const row = await resolveIngredient(ing(
        "Gurkenwasser", "Gurkenwasser", "cucumber water", "Gurke", core, { category: "liquid", grams: 20 },
      ))
      expect(row.providerId, `core=${core}`).not.toBe("174158")
    }
  })

  it("generalises to any derived liquid, concentrate or seasoning", () => {
    const carrier = (q: string, c: string) => carrierConflict(q, c, GENERIC_DESCRIPTOR_WORDS)
    // The source is absent from the candidate -> the candidate is the carrier, not the food.
    expect(carrier("cucumber water", "Water, bottled, generic")).toBe(true)
    expect(carrier("apple juice", "Water, bottled, generic")).toBe(true)
    expect(carrier("vanilla extract", "Alcoholic beverage, distilled, all (gin, rum, vodka, whiskey)")).toBe(true)
    expect(carrier("chicken broth", "Water, bottled, generic")).toBe(true)
    expect(carrier("Gurkenwasser", "Trinkwasser")).toBe(true)

    // The source IS named -> not a carrier, whether spelled apart or fused into a compound.
    expect(carrier("apple juice", "Apple juice, canned or bottled, unsweetened, without added ascorbic acid")).toBe(false)
    expect(carrier("tomato paste", "Tomato products, canned, paste, without salt added")).toBe(false)
    expect(carrier("garlic seasoning", "Spices, garlic powder")).toBe(false)
    expect(carrier("Tomatenmark", "Tomatenmark")).toBe(false)
    expect(carrier("Apfelsaft", "Apfelsaft")).toBe(false)

    // A query that IS the carrier names no source, so the rule must stay silent.
    expect(carrier("water", "Water, bottled, generic")).toBe(false)
    expect(carrier("Wasser", "Trinkwasser")).toBe(false)
    // …and a query that names no derived product at all is out of scope entirely.
    expect(carrier("black bean", "Beans, black, mature seeds, raw")).toBe(false)
  })

  it("plain water is still answered by a plain water record", async () => {
    const row = await resolveIngredient(ing("Wasser", "Wasser", "water", "Wasser", "water", { category: "liquid" }))
    expect(row.providerId).toBe("174158")
    expect(row.kcalPer100g).toBe(0)
  })
})

describe("ingredients that already resolved correctly are untouched", () => {
  // Every row here was measured on the deployed build before this change and must be identical
  // after it. They are the fast-path controls: the fixes above may only affect queries whose
  // identity was being decided by something other than the query.
  const CONTROLS: [FixtureIngredient, string, string][] = [
    [ing("Olivenöl", "Olivenöl", "olive oil", "Öl", "oil", { category: "oil" }), "bls", "Olivenöl"],
    [ing("Tomate", "Tomate", "tomato", "Tomate", "tomato", { category: "vegetable", state: "raw" }), "bls", "Tomate roh"],
    [ing("Tomatenmark", "Tomatenmark", "tomato paste", "Tomatenmark", "tomato paste", { category: "vegetable", attributes: { form: "paste" } }), "bls", "Tomatenmark"],
    [ing("Zwiebel", "Zwiebel", "onion", "Zwiebel", "onion", { category: "vegetable", state: "raw" }), "bls", "Speisezwiebel roh"],
    [ing("Chilipulver", "Chilipulver", "chili powder", "Chili", "chili", { category: "spice", attributes: { form: "powder" } }), "usda-local", "Spices, chili powder"],
    [ing("Knoblauchgewürz", "Knoblauchgewürz", "garlic seasoning", "Knoblauch", "garlic", { category: "spice" }), "usda-local", "Spices, garlic powder"],
  ]

  for (const [i, provider, record] of CONTROLS) {
    it(`${i.name} still resolves to ${provider} "${record}"`, async () => {
      const row = await resolveIngredient(i)
      expect(row.provider).toBe(provider)
      expect(row.productName).toBe(record)
    })
  }
})
