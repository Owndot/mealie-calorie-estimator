import { describe, it, expect, beforeAll, afterEach, vi } from "vitest"
import { initCache } from "../src/utils/cache.js"
import { estimateRecipe } from "../src/services/estimator.js"
import {
  lookupVocabulary, narrowsAmbiguousIngredient, vocabularyEntryCount,
} from "../src/services/vocabulary/recipe-vocabulary.js"
import { normalizeIdentityText } from "../src/utils/text-normalize.js"
import { buildResolverQuery } from "../src/services/resolver-query.js"
import { resolveNutrients } from "../src/services/nutrient-resolver.js"
import * as normalizer from "../src/services/llm-normalizer.js"
import * as registry from "../src/services/providers/registry.js"
import * as bls from "../src/services/providers/bls-provider.js"
import * as usda from "../src/services/providers/usda-local-provider.js"
import { UNKNOWN_ATTRIBUTES, type IngredientClassification, type ProviderMatch } from "../src/types.js"
import type { ProviderQuery } from "../src/services/providers/types.js"
import type { MealieRecipe } from "../src/types.js"

/**
 * The curated vocabulary is a sparse patch over a working resolver, not a replacement for it.
 *
 * Every row here exists because a 22-recipe corpus measured that term resolving wrongly, unsafely,
 * or not at all — and every target was verified against the bundled databases. An independent
 * 117-recipe corpus matched only 10% of its ingredient occurrences against these aliases, which is
 * exactly why the table is small and why "add an alias just in case" is the wrong instinct: a row
 * is a standing claim about a food, and a wrong one is worse than a missing one.
 *
 * So this file tests both halves. The terms the vocabulary is supposed to fix, and — at least as
 * important — the terms it must leave completely alone.
 */

function oneIngredient(name: string): MealieRecipe {
  return {
    slug: "vocab-test", name: "vocab-test", recipeYield: null, recipeServings: 1,
    recipeIngredient: [{
      quantity: 100,
      unit: { id: "g", name: "g", pluralName: "g", abbreviation: null, standardQuantity: null, standardUnit: null },
      food: { id: name, name, pluralName: null, aliases: [] },
      note: null, display: `100 g ${name}`, title: null, originalText: `100 g ${name}`,
    }],
    nutrition: null, tags: [], extras: {}, householdId: null,
  }
}

async function resolve(name: string) {
  const r = await estimateRecipe(oneIngredient(name))
  const m = r.matchedIngredients?.[0]
  return {
    id: m?.providerId ?? null, product: m?.productName ?? null,
    kcal: m?.nutrients?.kcalPer100g ?? null, reason: m?.matchReason ?? null,
    vocabulary: m?.classification?.vocabulary ?? null,
  }
}

vi.mock("../src/services/mealie-client.js", () => ({
  listRecipeNames: vi.fn(async () => []),
  getRecipe: vi.fn(async () => { throw new Error("No Mealie recipes in vocabulary fixtures") }),
}))

beforeAll(async () => { await initCache() })
afterEach(() => { vi.restoreAllMocks() })

describe("the resource loads and validates", () => {
  it("holds the measured entries and rejects nothing at startup", () => {
    // 74 German + 10 English. A rejected row is logged at error level and dropped, so a count
    // below this means the resource stopped validating.
    expect(vocabularyEntryCount()).toBe(84)
  })

  it("keys on the production normalizer, so a lookup finds what a resolution would", () => {
    const m = lookupVocabulary("Paprikapulver (edelsüß)")
    expect(m?.normalizedAlias).toBe(normalizeIdentityText("Paprikapulver (edelsüß)"))
    expect(m?.kind).toBe("exact_phrase")
  })

  it("is exact-match only — no fuzzy distance in v1", () => {
    // "Kodneybohnen" is a row because someone wrote it. A near-miss that is NOT a row must miss.
    expect(lookupVocabulary("Kodneybohnen")?.kind).toBe("spelling_variant")
    expect(lookupVocabulary("Kdneybohnen")).toBeNull()
    expect(lookupVocabulary("Mehlx")).toBeNull()
  })
})

describe("measured failures the vocabulary exists to fix", () => {
  const cases: [string, string, number][] = [
    ["Rinderhackfleisch", "U010100", 224],
    ["Crème fraîche", "M176800", 265],
    ["Petersilie", "G250100", 33],
    ["glatte Petersilie", "G250100", 33],
    ["Mehl", "C214100", 348],
    ["Mehl (Type 405)", "C214100", 348],
    ["Milch", "M111300", 62],
    ["Milch (Vollmilch)", "M111300", 62],
    ["Basmatireis", "C352000", 351],
    ["Baby-Spinat", "G211100", 18],
    ["Kirschtomaten", "G561100", 22],
    ["Paprikapulver", "171329", 282],
    ["Paprikapulver (edelsüß)", "171329", 282],
    ["Ei", "171287", 143],
    ["Eier", "171287", 143],
    ["Eier (Größe M)", "171287", 143],
    ["Knoblauchzehen", "G490100", 97],
    ["Limete", "F602100", 28],
    ["Kurkuma", "172231", 312],
    ["Zimt", "171320", 247],
    ["Muskat", "171326", 525],
    ["Lorbeerblätter", "170917", 313],
    ["Tahini", "Q901000", 595],
    ["Sprudel", "N127000", 0],
    ["chinesische Eiernudeln", "E432000", 342],
  ]

  for (const [term, id, kcal] of cases) {
    it(`${term} resolves to ${id}`, async () => {
      const r = await resolve(term)
      expect(r.id, `${term} resolved to ${r.product}`).toBe(id)
      expect(r.kcal).toBe(kcal)
    })
  }

  it("English terms are covered by their own language file", async () => {
    // Confirmed non-German failures: corned beef for mince, and PLUMS for plum tomatoes.
    expect((await resolve("ground beef")).id).toBe("U010100")
    expect((await resolve("Plum Tomatoes")).id).toBe("G561100")
  })

  it("a phrase that states a state is read as identity + state, not as an opaque alias", async () => {
    const r = await resolve("Cooked Puy Lentils")
    expect(r.id).toBe("H730132")          // Linse reif, gekocht
    expect(r.kcal!).toBeLessThan(200)     // ~119 cooked, against ~360 dry
    expect(lookupVocabulary("Cooked Puy Lentils")?.attributes.state).toBe("cooked")
  })
})

describe("terms that must be left completely alone", () => {
  // Measured as already correct. A row for any of these would be maintenance cost and risk —
  // "Zucker" in particular goes UNRESOLVED if given a naive identity.
  const untouched: [string, string][] = [
    ["Wasser", "N110000"], ["Zucker", "S111000"], ["Salz", "R111000"], ["Olivenöl", "Q120000"],
    ["Vollmilch", "M111300"], ["Wurzelpetersilie", "G670100"], ["Paprika", "G541100"],
    ["Paprika rosenscharf", "171329"], ["Kidneybohnen", "H742100"], ["Schlagsahne", "M173800"],
  ]

  for (const [term, id] of untouched) {
    it(`${term} is untouched by the vocabulary`, async () => {
      const r = await resolve(term)
      expect(r.id, `${term} resolved to ${r.product}`).toBe(id)
      expect(lookupVocabulary(term), `${term} must have no vocabulary row`).toBeNull()
      expect(r.reason).not.toMatch(/recipe-vocabulary/)
    })
  }
})

describe("explicit specialization always beats a generic default", () => {
  it("a stated grain is not replaced by the flour default", async () => {
    // "Mehl" defaults to wheat. "Gerstenmehl" states barley and must keep it.
    const r = await resolve("Gerstenmehl")
    expect(r.id).not.toBe("C214100")
    expect(r.product).toMatch(/Gerste/i)
  })

  it("a stated fat class is not replaced by the milk default", async () => {
    const r = await resolve("fettarme Milch")
    expect(r.id).toBe("M111200")
    expect(r.kcal).toBe(44)
  })

  it("a stated plant part is not replaced by the parsley default", async () => {
    const r = await resolve("Wurzelpetersilie")
    expect(r.id).toBe("G670100")
  })

  it("a stated variety keeps its own record", async () => {
    expect((await resolve("schwarze Bohnen")).id).toBe("173734")
    expect((await resolve("Kidneybohnen")).id).toBe("H742100")
  })

  it("the paprika spice is not turned into a vegetable", async () => {
    const r = await resolve("Paprika rosenscharf")
    expect(r.id).toBe("171329")
    expect(r.kcal).toBeGreaterThan(200)
  })
})

describe("ambiguity blocks narrowing without blocking a generic answer", () => {
  for (const term of ["Bohnen", "Öl", "Koriander"]) {
    it(`${term} refuses to guess`, async () => {
      expect(lookupVocabulary(term)?.kind).toBe("ambiguous")
      const r = await resolve(term)
      expect(r.id, `${term} resolved to ${r.product}`).toBeNull()
    })
  }

  it("an ambiguity row carries no identity, attributes or preferred record", () => {
    const m = lookupVocabulary("Bohnen")!
    expect(m.identity).toBeNull()
    expect(m.preferred).toBeNull()
    expect(Object.keys(m.attributes)).toHaveLength(0)
  })

  it("narrowing is what is refused, not specificity in general", () => {
    // A record introducing a variety the ingredient never named narrows it...
    expect(narrowsAmbiguousIngredient("Bohnen", "Bohne grün, roh")).toBe(true)
    expect(narrowsAmbiguousIngredient("Bohnen", "Kidneybohne reif")).toBe(true)
    // ...while a generic record, or one differing only by preparation, does not.
    expect(narrowsAmbiguousIngredient("Bohnen", "Bohne")).toBe(false)
    expect(narrowsAmbiguousIngredient("Bohnen", "Bohne gekocht")).toBe(false)
  })
})

describe("a preferred record is a hint, never an instruction", () => {
  it("is reported as a vocabulary match rather than as an ordinary lexical one", async () => {
    const r = await resolve("Kurkuma")
    expect(r.reason).toMatch(/^recipe-vocabulary:/)
    expect(r.vocabulary).toEqual({ alias: "Kurkuma", kind: "synonym", semanticsApplied: true, preferredSelected: true })
  })

  it("a recipe_default is recorded as an assumption, distinguishable from a stated fact", async () => {
    // "Mehl" does not state Type 405; the project chose it. Provenance must not claim otherwise.
    expect((await resolve("Mehl")).vocabulary).toEqual({ alias: "Mehl", kind: "recipe_default", semanticsApplied: true, preferredSelected: true })
    expect((await resolve("Tahini")).vocabulary).toEqual({ alias: "Tahini", kind: "synonym", semanticsApplied: true, preferredSelected: true })
  })

  it("every preferred target names a database provider, never copied nutrients", async () => {
    const m = lookupVocabulary("Kurkuma")!
    expect(m.preferred).toEqual({ provider: "usda-local", id: "172231" })
    expect(JSON.stringify(m)).not.toMatch(/kcalPer100g/)
  })
})

describe("prepared and composite foods stay deferred", () => {
  it("has no row for a spice blend or a prepared paste", () => {
    // The nearest record for Garam Masala is "Spices, curry powder" — a DIFFERENT blend. Mapping
    // it would be a fabrication, so these are deliberately absent.
    for (const term of ["Garam Masala", "Tikka-Paste", "Utskho Suneli",
                        "italienische Gewürzmischung", "Hoisin-Sauce",
                        "Gemüsebrühwürfel (für je 0,5 l)", "Gewürzpaste für Gemüsebrühe, selbst gemacht"]) {
      expect(lookupVocabulary(term), `${term} must stay deferred`).toBeNull()
    }
  })
})

describe("Rohrzucker is masked here, but the mechanism is not fixed", () => {
  it("resolves through the vocabulary while the compound-head defect remains", async () => {
    // #56: the core gate still admits "Zuckermais" for "Rohrzucker" and still rejects
    // "Zucker weiß". This row hides the symptom for one input; it is not the fix.
    const r = await resolve("Rohrzucker")
    expect(r.id).toBe("S111000")
    expect(r.reason).toMatch(/^recipe-vocabulary:/)
  })
})

function classified(overrides: Partial<IngredientClassification> = {}): IngredientClassification {
  return {
    index: 0, canonicalGerman: "Gerstenmehl", canonicalEnglish: "barley flour",
    coreFoodGerman: "Gerstenmehl", coreFoodEnglish: "barley flour", brand: null,
    category: null, state: "unknown", attributes: UNKNOWN_ATTRIBUTES, foodType: "simple",
    route: "generic", llmClassified: true, ...overrides,
  }
}

describe("classifier precedence and decision provenance", () => {
  it("a classifier's barley interpretation of Mehl cannot select the wheat default", async () => {
    vi.spyOn(normalizer, "normalizeIngredients").mockResolvedValue([classified()])
    const built = buildResolverQuery("Mehl", classified())
    expect(built.query.coreFoodGerman).toBe("Gerstenmehl")
    expect(built.query.vocabulary?.preferred).toBeUndefined()
    const result = await resolve("Mehl")
    expect(result.id).not.toBe("C214100")
    expect(result.product).toMatch(/Gerste|barley/i)
    expect(result.vocabulary).toEqual({ alias: "Mehl", kind: "recipe_default", semanticsApplied: false, preferredSelected: false })
  })

  it.each([
    classified({ coreFoodGerman: null, coreFoodEnglish: null }),
    classified({ llmClassified: false }),
    classified({ llmClassified: false, coreFoodGerman: null }),
  ])("does not fill ENRICHMENT when classifier support exists: %j", (classification) => {
    // Enrichment only — identity text, attributes, state. The classifier owns these and the
    // vocabulary must not overwrite them. Assertions are a different thing entirely; see below.
    const built = buildResolverQuery("Cooked Puy Lentils", classification)
    expect(built.query.state).toBe("unknown")
    expect(built.query.coreFoodGerman).toBe(classification.coreFoodGerman)
    expect(built.query.vocabulary).toMatchObject({ semanticsApplied: false })
  })

  it.each([
    classified({ coreFoodGerman: null, coreFoodEnglish: null }),
    classified({ llmClassified: false }),
    classified({ llmClassified: false, coreFoodGerman: null }),
    classified({ canonicalGerman: "Bohnen", canonicalEnglish: "beans", coreFoodGerman: "Bohnen", coreFoodEnglish: "beans" }),
  ])("keeps the ambiguity ASSERTION whatever the classifier produced: %j", (classification) => {
    // The inverse of the case above, and the reason the two are now separate tests: a curated
    // refusal to guess is not enrichment and is never filled in by a classifier's confidence.
    expect(buildResolverQuery("Bohnen", classification).query.vocabulary?.ambiguous).toBe(true)
  })

  it.each(["mealie-recipe", "food-override"])("%s wins before a vocabulary preference, and provenance says so", async (provider) => {
    const record = await bls.loadBlsRecordByCode("C214100")
    const match: ProviderMatch = {
      nutrients: record!.nutrients, canonicalName: "Mehl", brand: null, state: "unknown",
      provider: provider === "mealie-recipe" ? "mealie-recipe" : "bls", providerId: "priority-record",
      productName: "User's flour", confidence: 1,
      matchReason: provider === "food-override" ? "user-confirmed-override" : "recipe",
    }
    const preferred = vi.spyOn(bls, "loadBlsRecordByCode")
    vi.spyOn(registry, "getProviderChain").mockReturnValue([
      { name: provider, lookup: vi.fn().mockResolvedValue(match) },
      { name: "bls", lookup: vi.fn().mockResolvedValue(null) },
    ])
    const result = await resolve("Mehl")
    expect(result.id).toBe("priority-record")
    expect(preferred).not.toHaveBeenCalled()
    expect(result.vocabulary).toEqual({ alias: "Mehl", kind: "recipe_default", semanticsApplied: false, preferredSelected: false })
  })

  it("records applied semantics but no selected preference after a missing target", async () => {
    vi.spyOn(bls, "loadBlsRecordByCode").mockResolvedValue(null)
    const result = await resolve("Mehl")
    expect(result.vocabulary).toEqual({ alias: "Mehl", kind: "recipe_default", semanticsApplied: true, preferredSelected: false })
    expect(result.reason).not.toMatch(/^recipe-vocabulary:/)
  })

  it("records only an observation if grams prevented any resolution attempt", async () => {
    const recipe = oneIngredient("Mehl")
    recipe.recipeIngredient[0]!.quantity = 1
    recipe.recipeIngredient[0]!.unit!.name = "unconvertible-test-unit"
    const result = await estimateRecipe(recipe)
    expect(result.matchedIngredients?.[0]?.grams).toBeNull()
    expect(result.matchedIngredients?.[0]?.classification?.vocabulary).toEqual({
      alias: "Mehl", kind: "recipe_default", semanticsApplied: false, preferredSelected: false,
    })
  })
})

describe("preferred target compatibility uses the existing semantic gates", () => {
  const cases: { name: string; query: Partial<ProviderQuery>; recordName?: string; recordType?: "composite_dish" }[] = [
    { name: "state", query: { state: "cooked" } },
    { name: "form", query: { attributes: { ...UNKNOWN_ATTRIBUTES, form: "whole" } }, recordName: "Vollmilch Pulver" },
    { name: "preservation", query: { attributes: { ...UNKNOWN_ATTRIBUTES, preservation: "fresh" } }, recordName: "Vollmilch getrocknet" },
    { name: "fresh versus processed form", query: { attributes: { ...UNKNOWN_ATTRIBUTES, preservation: "fresh" } }, recordName: "Vollmilch Pulver" },
    { name: "measured fat", query: { attributes: { ...UNKNOWN_ATTRIBUTES, fatPercent: 20 } } },
    // "German core" was here. It is deliberately gone: coreIdentityConflict no longer validates a
    // curated pointer, because a classifier's free-text core is not evidence about a reviewed
    // mapping — it was what dropped "Basmatireis" -> C352000 whenever AI was enabled. The
    // classifier can still reject a pointer by RENAMING the food; that is covered separately by
    // "a classifier's barley interpretation of Mehl cannot select the wheat default".
    { name: "food type", query: { foodType: "simple" }, recordType: "composite_dish" },
    { name: "qualitative modifier shortfall", query: { structuredName: "fettarme Milch" } },
  ]
  it.each(cases)("rejects a preferred record conflicting with $name and continues the chain", async ({ query, recordName, recordType }) => {
    const record = await bls.loadBlsRecordByCode("M111300")
    vi.spyOn(bls, "loadBlsRecordByCode").mockResolvedValue({ ...record!, state: "raw", ...(recordName ? { name: recordName } : {}), ...(recordType ? { foodType: recordType } : {}) })
    const next = vi.fn().mockResolvedValue(null)
    vi.spyOn(registry, "getProviderChain").mockReturnValue([{ name: "bls", lookup: next }])
    const built = buildResolverQuery("Milch", undefined)
    expect(await resolveNutrients({ ...built.query, ...query }, built.route)).toBeNull()
    expect(next).toHaveBeenCalledOnce()
  })

  it("a mismatched English core alone no longer rejects a USDA target", async () => {
    // Was "enforces English core identity on a USDA target". The same change as the removed
    // "German core" case, on the USDA side: a core the classifier invented does not get to
    // overrule a reviewed pointer. "Ei" -> USDA 171287 is that pointer, and it now stands.
    // What still rejects it is real contradicting evidence — state, form, preservation, fat,
    // food type, modifier shortfall — each covered by the cases above, plus a rename by the
    // classifier, covered by the Mehl test.
    const built = buildResolverQuery("Ei", undefined)
    built.query.coreFoodEnglish = "beef"
    const next = vi.fn().mockResolvedValue(null)
    vi.spyOn(registry, "getProviderChain").mockReturnValue([{ name: "usda-local", lookup: next }])
    const resolved = await resolveNutrients(built.query, built.route)
    expect(resolved?.match.providerId).toBe("171287")
    expect(resolved?.match.matchReason).toMatch(/^recipe-vocabulary:/)
  })

  it("checks USDA form and preservation metadata too", async () => {
    const built = buildResolverQuery("Kurkuma", undefined)
    built.query.attributes = { ...UNKNOWN_ATTRIBUTES, preservation: "fresh" }
    vi.spyOn(registry, "getProviderChain").mockReturnValue([{ name: "usda-local", lookup: vi.fn().mockResolvedValue(null) }])
    expect(await resolveNutrients(built.query, built.route)).toBeNull()
  })

  it("rejects nutritionally impossible preferred records", async () => {
    const record = await usda.loadUsdaRecordById("171287")
    vi.spyOn(usda, "loadUsdaRecordById").mockResolvedValue({ ...record!, nutrients: { ...record!.nutrients, kcalPer100g: 10000 } })
    vi.spyOn(registry, "getProviderChain").mockReturnValue([{ name: "usda-local", lookup: vi.fn().mockResolvedValue(null) }])
    const built = buildResolverQuery("Ei", undefined)
    expect(await resolveNutrients(built.query, built.route)).toBeNull()
  })
})

it("keeps unknown record metadata permissive rather than claiming verification", async () => {
  const record = await bls.loadBlsRecordByCode("M111300")
  vi.spyOn(bls, "loadBlsRecordByCode").mockResolvedValue({
    ...record!, name: "Vollmilch", state: "unknown", nutrients: { ...record!.nutrients, fatPer100g: null },
  })
  const built = buildResolverQuery("Milch", undefined)
  built.query.state = "cooked"
  built.query.attributes = { form: "whole", preservation: "fresh", fatPercent: 3.5 }
  const result = await resolveNutrients(built.query, built.route)
  expect(result?.vocabularyPreferredSelected).toBe(true)
})

/**
 * THE PARITY INVARIANT.
 *
 * Enabling AI must never make a curated ingredient LESS safe. The vocabulary's two assertion
 * kinds — a reviewed `preferred` pointer and a reviewed `ambiguous` refusal — were both gated on
 * "did a classifier run", which meant turning the classifier on silently deleted them. Measured
 * before this was fixed, with the vocabulary loaded and every row intact:
 *
 *   Basmatireis    deterministic -> BLS C352000 (351 kcal) | AI -> UNRESOLVED -> fabricated estimate
 *   Bohnen         deterministic -> withheld (28-344 kcal) | AI -> "Beans, cannellini, dry" at 345
 *   rote Paprika   deterministic -> G543100 (red)          | AI -> G541100 (green)
 *
 * AI may still change the outcome — but only by contributing evidence: a stated state, form,
 * preservation or fat class that the record contradicts, or by renaming the food outright. A core
 * it invented for its own retrieval is not evidence about a mapping a human reviewed.
 */
describe("curated assertions survive AI classification", () => {
  const ai = (name: string, english: string, overrides: Partial<IngredientClassification> = {}): IngredientClassification => ({
    index: 0, canonicalGerman: name, canonicalEnglish: english,
    coreFoodGerman: name, coreFoodEnglish: english, brand: null, category: null,
    state: "unknown", attributes: UNKNOWN_ATTRIBUTES, foodType: "simple",
    route: "generic", llmClassified: true, ...overrides,
  })

  /** Resolves `name` exactly as production would, with the classifier's answer stubbed. */
  async function resolveWithClassifier(name: string, classification: IngredientClassification) {
    vi.spyOn(normalizer, "normalizeIngredients").mockResolvedValue([classification])
    return resolve(name)
  }

  it("Basmatireis reaches the curated record in BOTH modes, not a fabricated estimate", async () => {
    const deterministic = await resolve("Basmatireis")
    expect(deterministic.id).toBe("C352000")
    expect(deterministic.product).toBe("Reis poliert, roh")

    // The shape observed in production: the classifier kept the cultivar as the core. The
    // compound gate then found "Basmatireis" absent from "Reis poliert, roh" and dropped a
    // reviewed pointer to a 351 kcal record.
    const cultivar = await resolveWithClassifier("Basmatireis", ai("Basmatireis", "Basmati rice"))
    expect(cultivar.id, "AI must not be worse than deterministic").toBe("C352000")
    expect(cultivar.reason).toMatch(/^recipe-vocabulary:/)
  })

  /**
   * THE SPELLING INVARIANT — the reason the guard is a semantic check and not string equality.
   *
   * The model does not write a food the same way twice. Measured on the recorded corpus it
   * rewrites canonicalGerman for 6 of 60 ingredients: plurals ("Röstzwiebel" -> "Röstzwiebeln"),
   * word order ("mageres Rinderhackfleisch" -> "Rinderhackfleisch, mager"), expanded
   * abbreviations ("Kidneybohnen a. d. Dose" -> "Kidneybohnen aus der Dose"). None of those is a
   * different food, and none may cost the ingredient its curated record.
   *
   * "Basmati-Reis" is the spelling the RECORDED production classification actually uses. Under
   * plain string inequality it suppressed the pointer and the ingredient landed on C359000 —
   * PARBOILED rice, a different product at 333 kcal — so the fix was defeated by a hyphen.
   */
  it.each([
    ["Basmatireis", "identical"],
    ["Basmati-Reis", "hyphenated — the RECORDED production spelling"],
    ["Basmati Reis", "spaced"],
    ["Reis", "generalised to the row's own curated identity"],
    ["Basmati-Reis, roh", "hyphenated with a state word"],
  ])("Basmatireis keeps the curated target when the model writes it as %j (%s)", async (canonicalGerman) => {
    const r = await resolveWithClassifier("Basmatireis",
      ai("Basmatireis", "Basmati rice", { canonicalGerman, coreFoodGerman: "Reis", coreFoodEnglish: "rice", state: "raw", category: "grain" }))
    expect(r.id, `resolved to ${r.product}`).toBe("C352000")
    expect(r.reason).toBe("recipe-vocabulary:recipe_default")
    expect(r.id, "C359000 is parboiled rice — a different product at 333 kcal").not.toBe("C359000")
    expect(r.kcal).toBe(351)
  })

  it("uses the exact recorded production classification object", async () => {
    // Not a convenient synthetic shape: these are the five fields the corpus recorded for
    // basmati, reproduced verbatim (production-fixtures.ts, KIDNEY_CURRY index 6).
    const r = await resolveWithClassifier("Basmatireis", ai("Basmatireis", "Basmati rice", {
      canonicalGerman: "Basmati-Reis", canonicalEnglish: "Basmati rice",
      coreFoodGerman: "Reis", coreFoodEnglish: "rice", state: "raw", category: "grain",
    }))
    expect(r.id).toBe("C352000")
    expect(r.reason).toBe("recipe-vocabulary:recipe_default")
    expect(r.vocabulary).toMatchObject({ alias: "Basmatireis", preferredSelected: true })
  })

  it.each([
    ["rote Paprika", "Paprika, rot", "bell pepper", "G543100", "G541100", "word order"],
    ["rote Paprika", "rote Gemüsepaprika", "bell pepper", "G543100", "G541100", "adjective expanded to the curated identity"],
  ])("%s keeps the RED record when the model writes %j (%s)", async (term, canonicalGerman, en, want, mustNot) => {
    const r = await resolveWithClassifier(term, ai(term, en, { canonicalGerman, coreFoodGerman: "Paprika", coreFoodEnglish: en }))
    expect(r.id, `resolved to ${r.product}`).toBe(want)
    expect(r.id, "the green record is a different vegetable").not.toBe(mustNot)
  })

  it("Limete keeps curated provenance when the model corrects the spelling", async () => {
    // The row exists BECAUSE "Limete" is a misspelling, so a classifier writing "Limette" is the
    // row agreeing with itself — the one rewrite that must never be read as a contradiction.
    const r = await resolveWithClassifier("Limete", ai("Limete", "lime", { canonicalGerman: "Limette", coreFoodGerman: "Limette" }))
    expect(r.id).toBe("F602100")
    expect(r.reason).toBe("recipe-vocabulary:spelling_variant")
  })

  /**
   * The other side of the rule. Each of these names a genuinely different food, and each must
   * send resolution back to the ordinary chain rather than hand over the curated pointer.
   */
  it.each([
    ["Mehl", "Gerstenmehl", "barley flour", "C214100", "barley is not wheat"],
    ["Milch", "Magermilch", "skim milk", "M111300", "skimmed is not whole milk"],
    ["Pflanzenöl", "Rapsöl", "rapeseed oil", "172370", "rapeseed is not soybean oil"],
  ])("%s + a classifier reading of %j must NOT select the curated target (%s)", async (term, canonicalGerman, en, mustNot) => {
    const built = buildResolverQuery(term, ai(term, en, { canonicalGerman, coreFoodGerman: canonicalGerman, coreFoodEnglish: en }))
    expect(built.query.vocabulary?.preferred, "a renamed food must drop the pointer").toBeUndefined()
    const r = await resolveWithClassifier(term, ai(term, en, { canonicalGerman, coreFoodGerman: canonicalGerman, coreFoodEnglish: en }))
    expect(r.id, `resolved to ${r.product}`).not.toBe(mustNot)
    expect(r.reason ?? "").not.toMatch(/^recipe-vocabulary:/)
  })

  it("Basmatireis uses the curated mapping rather than reaching the record by accident", async () => {
    // A good classifier core ("Reis"/"rice") ALSO finds C352000 through ordinary fuzzy matching,
    // so asserting the id alone would pass even with the pointer still suppressed. The match
    // REASON is what distinguishes a curated decision from a lucky one.
    const r = await resolveWithClassifier("Basmatireis", ai("Basmatireis", "Basmati rice", {
      coreFoodGerman: "Reis", coreFoodEnglish: "rice",
    }))
    expect(r.id).toBe("C352000")
    expect(r.reason).toBe("recipe-vocabulary:recipe_default")
    expect(r.vocabulary).toMatchObject({ alias: "Basmatireis", preferredSelected: true })
  })

  it.each([
    ["Bohnen", "beans", "2644281"],
    ["Koriander", "coriander", "170922"],
  ])("%s stays ambiguous under a generic '%s' classification", async (term, english, mustNotBe) => {
    expect((await resolve(term)).id, `${term} deterministic`).toBeNull()
    const r = await resolveWithClassifier(term, ai(term, english))
    expect(r.id, `${term} resolved to ${r.product} with AI on`).toBeNull()
    expect(r.id).not.toBe(mustNotBe)
  })

  it("rote Paprika keeps the RED record in both modes", async () => {
    expect((await resolve("rote Paprika")).id).toBe("G543100")
    const r = await resolveWithClassifier("rote Paprika", ai("rote Paprika", "red bell pepper"))
    expect(r.id).toBe("G543100")
    expect(r.product).toMatch(/rot/)
    expect(r.id, "the green record is a different vegetable").not.toBe("G541100")
  })

  it("Limete keeps curated provenance in both modes", async () => {
    for (const [mode, r] of [
      ["deterministic", await resolve("Limete")],
      ["ai", await resolveWithClassifier("Limete", ai("Limete", "lime"))],
    ] as const) {
      expect(r.id, mode).toBe("F602100")
      expect(r.reason, mode).toBe("recipe-vocabulary:spelling_variant")
    }
  })

  it("does NOT make curated pointers unconditional: stated state still rejects one", async () => {
    // The other half of the invariant. "Mehl" prefers C214100; a classifier that states a
    // preparation the record contradicts must still send resolution back to the chain.
    const built = buildResolverQuery("Milch", ai("Milch", "milk", { state: "cooked" }))
    expect(built.query.vocabulary?.preferred).toBeDefined()
    const record = await bls.loadBlsRecordByCode("M111300")
    vi.spyOn(bls, "loadBlsRecordByCode").mockResolvedValue({ ...record!, state: "raw" })
    const next = vi.fn().mockResolvedValue(null)
    vi.spyOn(registry, "getProviderChain").mockReturnValue([{ name: "bls", lookup: next }])
    expect(await resolveNutrients(built.query, built.route)).toBeNull()
    expect(next, "resolution must continue down the chain").toHaveBeenCalledOnce()
  })

  it("does NOT make curated pointers unconditional: a renamed food rejects one", async () => {
    // The classifier read "Mehl" and called the food barley. That is identity evidence, and it
    // outranks a default written for the bare word — unlike a core it invented for retrieval.
    const built = buildResolverQuery("Mehl", ai("Mehl", "barley flour", {
      canonicalGerman: "Gerstenmehl", coreFoodGerman: "Gerstenmehl",
    }))
    expect(built.query.vocabulary?.preferred).toBeUndefined()
    expect(built.query.vocabulary).toMatchObject({ alias: "Mehl", kind: "recipe_default" })
  })
})
