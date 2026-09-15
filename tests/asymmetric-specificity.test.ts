import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest"
import { config } from "../src/config.js"
import { initCache } from "../src/utils/cache.js"
import { resolveIngredient, type ResolvedRow } from "./helpers/resolve-fixture.js"
import type { FixtureIngredient } from "./helpers/nutrition-fixtures.js"
import { stubProviderResponses } from "./helpers/resolve-fixture.js"

/**
 * ASYMMETRIC SPECIFICITY — the failure class found by validating three real Mealie recipes.
 *
 * The rule under test, in one sentence: a candidate may be BROADER than the query but not
 * NARROWER in a way the query never asked for. Broadening is an honest fallback ("Basmati-Reis"
 * -> generic polished rice); narrowing invents a fact ("Nudeln" -> RICE noodles, "Senf" -> SWEET
 * mustard, an ambiguous "Koriander" -> coriander SEED).
 *
 * These are written against the mechanisms, using the real ingredient texts that failed live and
 * the real BLS database, so a regression reads as "the rule stopped holding" rather than "one
 * food changed". Each case names the direction of the asymmetry it guards.
 */
beforeAll(async () => {
  await initCache()
})

beforeEach(() => {
  config.usda.apiKey = "fixture-key"
  // Both backoffs, not just USDA's: the OFF default is 500 ms exponential over 3 retries, so every
  // deliberately-unresolved fixture ingredient slept 3.5 s against a stub that answers instantly.
  config.usda.retryBackoffMs = 1
  config.openFoodFacts.retryBackoffMs = 1
  config.llm.enabled = false
  config.llm.apiKey = ""
  vi.restoreAllMocks()
  stubProviderResponses()
})

/** The live ingredients, with the classification the whole-recipe normalizer produces for them. */
const ING: Record<string, FixtureIngredient> = {
  // "Knuspriger Big Mac Salat"
  nudeln: { name: "Nudeln", canonicalGerman: "Nudeln", canonicalEnglish: "pasta", coreFoodGerman: "Nudeln", coreFoodEnglish: "pasta", grams: 300, state: "raw", foodType: "processed_single_food" },
  senf: { name: "Senf", canonicalGerman: "Senf", canonicalEnglish: "mustard", coreFoodGerman: "Senf", coreFoodEnglish: "mustard", grams: 4, state: "unknown", foodType: "processed_single_food" },
  gurkenwasser: { name: "Gurkenwasser", canonicalGerman: "Gurkenwasser", canonicalEnglish: "cucumber water", coreFoodGerman: "Gurke", coreFoodEnglish: "cucumber", grams: 20, state: "unknown", foodType: "processed_single_food" },
  knoblauchgewuerz: { name: "Knoblauchgewürz", canonicalGerman: "Knoblauchgewürz", canonicalEnglish: "garlic seasoning", coreFoodGerman: "Knoblauch", coreFoodEnglish: "garlic", grams: 4, state: "unknown", foodType: "processed_single_food" },
  // "Butter Chicken"
  ghee: { name: "Ghee", canonicalGerman: "Ghee", canonicalEnglish: "ghee", coreFoodGerman: "Ghee", coreFoodEnglish: "ghee", grams: 40, state: "unknown", foodType: "processed_single_food" },
  koriander: { name: "Koriander", canonicalGerman: "Koriander", canonicalEnglish: "coriander", coreFoodGerman: "Koriander", coreFoodEnglish: "coriander", grams: 10, state: "unknown", foodType: "simple" },
  korianderGetrocknet: { name: "Getrockneter Koriander", canonicalGerman: "Koriander, getrocknet", canonicalEnglish: "dried coriander", coreFoodGerman: "Koriander", coreFoodEnglish: "coriander", grams: 8, state: "dried", foodType: "simple" },
  // "Einfaches Kidney-Bohnen-Tomaten-Curry"
  kidney: { name: "Kidneybohnen a. d. Dose", canonicalGerman: "Kidneybohnen a. d. Dose", canonicalEnglish: "canned kidney beans", coreFoodGerman: "Kidneybohne", coreFoodEnglish: "kidney bean", grams: 400, state: "unknown", foodType: "processed_single_food" },
  basmati: { name: "Basmati-Reis", canonicalGerman: "Basmati-Reis", canonicalEnglish: "basmati rice", coreFoodGerman: "Reis", coreFoodEnglish: "rice", grams: 100, state: "raw", foodType: "simple" },
}

/** Every provider is allowed to answer; the assertion is about WHICH record may win, not which provider. */
const resolve = (i: FixtureIngredient) => resolveIngredient(i)
const describeRow = (r: ResolvedRow) => `${r.provider}/${r.productName ?? "—"}/${r.kcalPer100g ?? "—"}`

describe("a candidate must not introduce a SUBTYPE the query never named", () => {
  it("generic pasta does not become rice noodles — and still reaches real pasta", async () => {
    // "Reisnudeln" literally contains "Nudeln", so containment scored rice noodles as if they were
    // plain pasta. BLS files pasta under a different lemma entirely ("Teigwaren"), which is why
    // rice noodles were the only reachable record at all.
    const row = await resolve(ING.nudeln)
    expect(describeRow(row)).not.toMatch(/Reisnudeln/)
    expect(row.provider, describeRow(row)).not.toBe("unresolved")
    // Dry wheat pasta is ~340-375 kcal/100 g. Rice noodles (~360 raw) are close, so energy alone
    // cannot carry this assertion — the record identity above is what matters.
    expect(row.kcalPer100g!).toBeGreaterThan(300)
  })

  it("plain mustard does not become SWEET mustard", async () => {
    // BLS has four mustards: three at 111 kcal differing only in heat, and "Senf süß" at 177.
    // The three neutral ones were each penalised for their heat word while "sweet" was forgiven,
    // so the one nutritionally different record was the only one that could win.
    const row = await resolve(ING.senf)
    expect(describeRow(row)).not.toMatch(/süß|suess|sweet/i)
    expect(row.provider).toBe("bls")
    expect(row.kcalPer100g!).toBeLessThan(140)
  })

  it("an ambiguous herb/seed name is never resolved to one part by guesswork", async () => {
    // USDA offers coriander as seed (298 kcal) AND as leaf (23 kcal). Nothing in a bare "Koriander"
    // says which, so picking either is a 13x coin flip. Falling through is the correct behaviour.
    const row = await resolve(ING.koriander)
    expect(describeRow(row)).not.toMatch(/seed|samen/i)
    expect(row.provider, describeRow(row)).not.toBe("usda")
  })

  it("stating a preparation does not resolve the part ambiguity either", async () => {
    // "Getrockneter Koriander" says DRIED, not which part — and USDA offers a dried leaf and a
    // seed. Preparation and plant part are independent axes.
    const row = await resolve(ING.korianderGetrocknet)
    expect(describeRow(row)).not.toMatch(/seed|samen/i)
  })
})

describe("a candidate must not drop a DERIVED-PRODUCT identity the query named", () => {
  it("garlic seasoning does not become raw garlic", async () => {
    const row = await resolve(ING.knoblauchgewuerz)
    expect(row.productName ?? "", describeRow(row)).not.toMatch(/^Garlic, raw|^Knoblauch roh/)
    // A garlic POWDER record is a legitimate answer — same derived class, different word.
    if (row.provider !== "unresolved") expect(row.productName!).toMatch(/powder|pulver|gewürz|seasoning/i)
  })

  it("pickle brine does not become raw cucumber", async () => {
    const row = await resolve(ING.gurkenwasser)
    expect(row.productName ?? "", describeRow(row)).not.toMatch(/Cucumber, raw|Gurke roh/)
  })

  it("the rule is self-limiting: a query whose CORE is the derived product still resolves", async () => {
    // "Tomatenmark" is itself a paste, so the paste marker must not reject every candidate.
    const row = await resolve({
      name: "Tomatenmark", canonicalGerman: "Tomatenmark", canonicalEnglish: "tomato paste",
      coreFoodGerman: "Tomatenmark", coreFoodEnglish: "tomato paste", grams: 70,
      state: "unknown", foodType: "processed_single_food",
    })
    expect(row.provider, describeRow(row)).not.toBe("unresolved")
    expect(row.productName!).toMatch(/mark|paste/i)
  })
})

describe("broadening in the other direction stays allowed", () => {
  it("Basmati rice may fall back to the generic polished-rice record", async () => {
    // BLS does not model cultivars. Dropping "Basmati" loses no nutrition; inventing "rice
    // noodles" for "pasta" would. The asymmetry between these two cases is the whole point.
    const row = await resolve(ING.basmati)
    expect(row.provider).toBe("bls")
    expect(row.productName!).toMatch(/Reis/)
    expect(row.kcalPer100g!).toBeGreaterThan(300)
    expect(row.kcalPer100g!).toBeLessThan(400)
  })
})

describe("a stated attribute must be answered, not merely not-contradicted", () => {
  it("canned kidney beans take the CANNED record, not the dry one and not a prepared survey entry", async () => {
    // The live failure and the largest single calorie error found: 400 g resolved to USDA's
    // "Kidney beans, NFS" (177 kcal/100 g, carrying ~7 g/100 g of cooking fat) = 708 kcal, where
    // BLS's "Kidneybohne reif, Konserve, abgetropft" (128) gives 512. The dry record (316) would
    // have been a 2.5x error in the other direction, and nothing rejected it: a candidate that
    // says nothing about preservation never conflicts with one that does.
    const row = await resolve(ING.kidney)
    expect(row.provider).toBe("bls")
    expect(row.productName!).toMatch(/Konserve/)
    expect(row.preservation).toBe("canned")
    expect(row.kcalPer100g!).toBeLessThan(200)
  })
})

describe("BLS lemma synonyms make ordinary foods reachable", () => {
  it("ghee resolves to Butterschmalz rather than falling through to an LLM estimate", async () => {
    const row = await resolve(ING.ghee)
    expect(row.provider).toBe("bls")
    expect(row.productName!).toMatch(/Butterschmalz/)
    expect(row.kcalPer100g!).toBeGreaterThan(800)
  })
})
