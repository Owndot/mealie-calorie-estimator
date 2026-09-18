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
  ])("does not fill any semantics when classifier support exists: %j", (classification) => {
    const built = buildResolverQuery("Cooked Puy Lentils", classification)
    expect(built.query.state).toBe("unknown")
    expect(built.query.coreFoodGerman).toBe(classification.coreFoodGerman)
    expect(built.query.vocabulary).toMatchObject({ semanticsApplied: false })
    expect(built.query.vocabulary?.preferred).toBeUndefined()
    expect(buildResolverQuery("Bohnen", classification).query.vocabulary?.ambiguous).toBeUndefined()
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
    { name: "German core", query: { coreFoodGerman: "Gerste" } },
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

  it("enforces English core identity on a USDA target", async () => {
    const built = buildResolverQuery("Ei", undefined)
    built.query.coreFoodEnglish = "beef"
    vi.spyOn(registry, "getProviderChain").mockReturnValue([{ name: "usda-local", lookup: vi.fn().mockResolvedValue(null) }])
    expect(await resolveNutrients(built.query, built.route)).toBeNull()
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
