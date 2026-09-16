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
  // Both backoffs, not just USDA's: the OFF default is 500 ms exponential over 3 retries, so every
  // deliberately-unresolved fixture ingredient slept 3.5 s against a stub that answers instantly.
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

describe("a generic query is never broadened into a different base ingredient", () => {
  // The rule these share: when BLS has no record for the plain food, the answer is a miss that the
  // next provider or an LLM estimate can answer honestly — never the nearest sub-variety. An
  // earlier revision accepted the sub-variety at reduced confidence "to preserve coverage", and
  // every one of these is a case it got wrong.
  const generic = (name: string, en: string, core: string, coreEn: string) => resolve({
    name, canonicalGerman: name, canonicalEnglish: en, coreFoodGerman: core, coreFoodEnglish: coreEn,
    grams: 100, state: "unknown", foodType: "simple",
  })

  it("generic flour does not become LUPIN flour", async () => {
    // H731400 Lupinenmehl is a legume flour: ~40 g protein/100 g against wheat's ~10. Note it is
    // within 4% of the median BLS flour by ENERGY, so no calorie-based plausibility check could
    // ever have caught it — only refusing to invent the base grain does.
    const row = await generic("Mehl", "flour", "Mehl", "flour")
    expect(row.productName ?? "", describeRow(row)).not.toMatch(/Lupinen|Kichererbsen|Soja|Mandel/i)
    expect(row.provider, describeRow(row)).not.toBe("bls")
  })

  it("but a query that NAMES its grain still resolves — the rule is directional", async () => {
    const row = await generic("Weizenmehl", "wheat flour", "Mehl", "flour")
    expect(row.provider).toBe("bls")
    expect(row.productName!).toMatch(/Weizen/)
    expect(row.kcalPer100g!).toBeGreaterThan(300)
    expect(row.kcalPer100g!).toBeLessThan(400)
  })

  it("the parsley herb does not become root parsley", async () => {
    // G670100 Wurzelpetersilie is a root vegetable at 76 kcal; the herb is 33.
    const row = await generic("Petersilie", "parsley", "Petersilie", "parsley")
    expect(row.productName ?? "", describeRow(row)).not.toMatch(/Wurzel/i)
  })

  it("peas do not become deep-fried snack peas", async () => {
    // D011000 Backerbsen, 469 kcal against 88 for green peas. It slipped through because the
    // candidate carried the PLURAL of the core ("back|erbsen" vs core "Erbse"), which the
    // sub-variety check only recognised in the other direction.
    //
    // Scope note, deliberately not asserted here: this resolves to "Erbse reif" (dry mature peas,
    // 311 kcal) rather than "Erbse grün" (88), because BLS's "reif" is a whitelisted descriptor
    // while the colour word is not. That is a separate mechanism — and the same whitelisting is
    // what lets "Kidneybohne reif, Konserve, abgetropft" be reached at all — so it is recorded as
    // a known limitation rather than papered over with an assertion this change does not earn.
    const row = await generic("Erbsen", "peas", "Erbse", "pea")
    expect(row.productName ?? "", describeRow(row)).not.toMatch(/Backerbsen/i)
    expect(row.kcalPer100g ?? 0, describeRow(row)).toBeLessThan(470)
  })

  it("a banana does not become a plantain", async () => {
    const row = await generic("Banane", "banana", "Banane", "banana")
    expect(row.productName ?? "", describeRow(row)).not.toMatch(/Kochbanane/i)
    expect(row.provider).toBe("bls")
  })

  it("margarine does not become a lamination or baking margarine", async () => {
    const row = await generic("Margarine", "margarine", "Margarine", "margarine")
    expect(row.productName ?? "", describeRow(row)).not.toMatch(/Zieh|Back/i)
  })
})

describe("a record that lists synonyms is not charged for its own alternate spellings", () => {
  it("resolves salt, whose BLS record is named \"A/B/C\"", async () => {
    // "Speisesalz/Siedesalz/Tafelsalz" matched on "Speisesalz" but was charged 35 points of
    // foreign content for "Siedesalz" — its own synonym — which dropped it from 57 to 22.
    const row = await resolve({
      name: "Salz", canonicalGerman: "Salz", canonicalEnglish: "salt", coreFoodGerman: "Salz",
      coreFoodEnglish: "salt", grams: 3, state: "unknown", foodType: "simple",
    })
    expect(row.provider).toBe("bls")
    expect(row.productName!).toMatch(/Speisesalz/)
    expect(row.kcalPer100g).toBe(0)
  })

  it("resolves a two-name vegetable record", async () => {
    const row = await resolve({
      name: "Karotte", canonicalGerman: "Karotte", canonicalEnglish: "carrot", coreFoodGerman: "Karotte",
      coreFoodEnglish: "carrot", grams: 100, state: "raw", foodType: "simple",
    })
    expect(row.provider).toBe("bls")
    expect(row.productName!).toMatch(/Karotte|Möhre/)
  })
})
