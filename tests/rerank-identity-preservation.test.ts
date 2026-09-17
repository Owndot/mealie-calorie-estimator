import { describe, it, expect } from "vitest"
import {
  rerankPreservesIdentity, parseRerankReply, identityKey,
  type RerankQuery, type IdentityCandidate, type RerankCandidate,
} from "../src/services/providers/candidate-rerank.js"
import { __buildTestBlsData } from "../src/services/providers/bls-provider.js"
import { UNKNOWN_ATTRIBUTES, type FoodAttributes, type NutrientSet } from "../src/types.js"

const ZERO_NUTRIENTS: NutrientSet = {
  kcalPer100g: 0, proteinPer100g: 0, fatPer100g: 0, carbsPer100g: 0,
  saturatedFatPer100g: null, unsaturatedFatPer100g: null, transFatPer100g: null,
  fiberPer100g: null, sugarPer100g: null, sodiumPer100g: null, cholesterolPer100g: null,
}

/**
 * The reranker chooses among records retrieval already found, so it cannot invent one — but until
 * this gate it could swap the food for a materially different food, and the only acceptance check
 * standing in its way REQUIRED the identity to change. That check exists to reject same-identity
 * noise; read as a pass condition it says the opposite of what is wanted.
 *
 * Measured live: a mince query took a mixed-species patty record, on the model's own reasoning
 * "Same base ingredient, state, and form" — a species change and a form change at once, invisible
 * because neither dimension is modelled (BLS annotates mince and patty alike as form "unknown").
 *
 * Everything here is synthetic. No real food, species list or database id appears, because the
 * rule is about tokens and evidence, not about any particular food.
 */

function query(overrides: Partial<RerankQuery> = {}): RerankQuery {
  return {
    provider: "test", structuredName: "Testfood", canonicalGerman: "Testfood",
    canonicalEnglish: "testfood", coreFood: "Testfood",
    state: "unknown", attributes: UNKNOWN_ATTRIBUTES,
    ...overrides,
  }
}

function candidate(identityTokens: string[], attributes: FoodAttributes = UNKNOWN_ATTRIBUTES): IdentityCandidate {
  return { identityTokens, attributes }
}

const attrs = (form: FoodAttributes["form"], preservation: FoodAttributes["preservation"]): FoodAttributes =>
  ({ form, preservation, fatPercent: null })

describe("a token the query supports must survive the replacement", () => {
  it("rejects a replacement that drops one of the winner's supported tokens", () => {
    // The query is a compound naming both parts; the winner carries both; the replacement keeps
    // only one and substitutes a near-miss for the other. That is a different food.
    const q = query({ structuredName: "Alphabeta", canonicalGerman: "Alphabeta", canonicalEnglish: "alpha beta", coreFood: "Alpha" })

    expect(rerankPreservesIdentity(q, candidate(["alpha", "beta"]), candidate(["alpha", "gamma", "betaform"]))).toBe(false)
  })

  it("allows a replacement that keeps every supported token and adds nothing", () => {
    const q = query({ structuredName: "Alphabeta", canonicalGerman: "Alphabeta", canonicalEnglish: "alpha beta", coreFood: "Alpha" })

    expect(rerankPreservesIdentity(q, candidate(["alpha"]), candidate(["alpha", "beta"]))).toBe(true)
  })
})

describe("new unsupported identity needs evidenced attribute gain", () => {
  it("rejects an introduced token when the ingredient asked for nothing", () => {
    // Neither side is accounted for by the query, and nothing was requested — so there is no
    // ground on which the swap is an improvement, and the deterministic winner stands.
    const q = query({ structuredName: "Basis", canonicalGerman: "Basis", canonicalEnglish: "base", coreFood: "Basis" })

    expect(rerankPreservesIdentity(q, candidate(["vollbasis"]), candidate(["rohbasis", "sonderbasis"]))).toBe(false)
  })

  it("allows an introduced token that answers an attribute the TEXT states", () => {
    // "aus der Dose" is in the ingredient's own words, so inferAttributesFromName reads
    // preservation=canned and a record stating it genuinely answers the question asked.
    // The winner deliberately carries an unaccounted token of its own, so the early "the winner
    // committed to nothing" exit cannot be what makes this pass — the escape itself is exercised.
    const q = query({
      structuredName: "Basis aus der Dose", canonicalGerman: "Basis aus der Dose",
      canonicalEnglish: "canned base", coreFood: "Basis",
    })

    const winner = candidate(["basis", "vollform"], attrs("unknown", "fresh"))
    const canned = candidate(["basis", "konserve"], attrs("unknown", "canned"))

    expect(rerankPreservesIdentity(q, winner, canned)).toBe(true)
    // ...and without the stated attribute, the same swap is refused.
    const silent = query({ structuredName: "Basis", canonicalGerman: "Basis", canonicalEnglish: "base", coreFood: "Basis" })
    expect(rerankPreservesIdentity(silent, winner, candidate(["basis", "konserve"], attrs("unknown", "canned")))).toBe(false)
  })
})

describe("adding specificity to a winner that committed to nothing stays allowed", () => {
  // These two are why condition (2) is narrow. Both are real reranks the suite already relied on,
  // and an earlier revision of this gate rejected them: unqualified peas legitimately becoming the
  // green record, and a sweet-pepper record legitimately giving way to a chili one. When the
  // deterministic winner carries no unstated identity of its own, the model is supplying knowledge
  // the ingredient omitted — which is the entire point of reranking.
  it("a bare winner may be replaced by a more specific record", () => {
    const q = query({ structuredName: "Basen", canonicalGerman: "Basis", canonicalEnglish: "bases", coreFood: "Basis" })

    expect(rerankPreservesIdentity(q, candidate(["basis"]), candidate(["basis", "gruen"]))).toBe(true)
  })

  it("a replacement covering MORE of the query is allowed even against a specialised winner", () => {
    // The winner answered half the query and guessed the rest; the replacement answers more of
    // what was actually written. That is an objective, query-relative gain — no LLM trust needed.
    const q = query({
      structuredName: "Alpha Gamma", canonicalGerman: "Alpha Gamma",
      canonicalEnglish: "alpha gamma", coreFood: "Alpha",
    })

    const winner = candidate(["alpha", "unstated"])
    const better = candidate(["alpha", "gamma", "andere"])

    expect(rerankPreservesIdentity(q, winner, better)).toBe(true)
  })

  it("an unevidenced classifier state cannot be that gain", () => {
    // The classifier emits state "raw" as a null value on most ingredients (#47). The escape is
    // computed from the query's own words, so the claim is simply not visible to it: identical
    // verdict whether the classifier claimed "raw" or said nothing.
    const base = {
      structuredName: "Basis", canonicalGerman: "Basis", canonicalEnglish: "base", coreFood: "Basis",
    }
    const winner = candidate(["vollbasis"], attrs("unknown", "fresh"))
    const proposed = candidate(["rohbasis", "sonderbasis"], attrs("unknown", "unknown"))

    const claimed = rerankPreservesIdentity(query({ ...base, state: "raw" }), winner, proposed)
    const silent = rerankPreservesIdentity(query({ ...base, state: "unknown" }), winner, proposed)

    expect(claimed).toBe(false)
    expect(claimed).toBe(silent)
  })

  it("a classifier attribute with no textual support cannot open the escape either", () => {
    // Same shape one level up: query.attributes is the classifier's, and the gate ignores it.
    const q = query({
      structuredName: "Basis", canonicalGerman: "Basis", canonicalEnglish: "base", coreFood: "Basis",
      attributes: attrs("unknown", "canned"), // claimed, but no word in "Basis" says so
    })

    expect(rerankPreservesIdentity(q, candidate(["vollbasis"]), candidate(["rohbasis"], attrs("unknown", "canned")))).toBe(false)
  })
})

describe("the shape of the two observed production regressions", () => {
  it("a specialisation of the query word is not 'supported by' the query", () => {
    // The asymmetry that makes the gate work: a query token may account for a record token inside
    // a compound, but a record token that merely CONTAINS the query word is a narrowing, not a
    // match. Getting this backwards would let every specialisation pass as already supported.
    const q = query({ structuredName: "Basis", canonicalGerman: "Basis", canonicalEnglish: "base", coreFood: "Basis" })

    // winner and replacement are both narrowings; neither is supported; no attribute asked for.
    expect(rerankPreservesIdentity(q, candidate(["vollbasis"]), candidate(["rohbasis"]))).toBe(false)
  })

  it("a second identity token added to a compound query is rejected", () => {
    // The mince/patty shape: the query names one source, the replacement names two and renames
    // the product. Both changes are caught without knowing what either token means.
    const q = query({
      structuredName: "Quellaprodukt", canonicalGerman: "Quellaprodukt",
      canonicalEnglish: "quella product", coreFood: "Quella",
    })

    const winner = candidate(["quella", "produkt"])
    const mixed = candidate(["quella", "quellb", "erzeugnis"])

    expect(rerankPreservesIdentity(q, winner, mixed)).toBe(false)
  })
})

describe("the rescue path is untouched", () => {
  it("with no deterministic winner every replacement is allowed", () => {
    // 16 of the 18 reranks on the frozen corpus are rescues: retrieval found nothing acceptable
    // and the model supplied a record. There is no identity to preserve, and this gate must not
    // interfere with any of them — including ones that add tokens the query never stated.
    const q = query({ structuredName: "Basis", canonicalGerman: "Basis", canonicalEnglish: "base", coreFood: "Basis" })

    expect(rerankPreservesIdentity(q, null, candidate(["basisblatt"]))).toBe(true)
    expect(rerankPreservesIdentity(q, null, candidate(["voellig", "anderes", "ding"]))).toBe(true)
  })
})

describe("the two production regressions, against the real records", () => {
  // The synthetic cases above prove the rule; these prove it fires on the exact inputs that were
  // measured failing, classifier state included. Names are read from the real BLS table so the
  // test cannot drift from the data — nothing about them is encoded in the implementation.
  function blsRecord(nameDe: string): IdentityCandidate {
    const data = __buildTestBlsData([{ blsCode: "X", nameDe, nutrients: ZERO_NUTRIENTS }])
    return { identityTokens: data.records[0].identityTokens, attributes: data.records[0].attributes }
  }

  it("a mince query does not accept a mixed-species patty record", () => {
    const q = query({
      structuredName: "Rinderhackfleisch", canonicalGerman: "Rinderhackfleisch",
      canonicalEnglish: "ground beef", coreFood: "Rind", state: "raw",
    })

    expect(rerankPreservesIdentity(q, blsRecord("Rind Hackfleisch, roh"), blsRecord("Rind/Schwein, Hacksteak, roh")))
      .toBe(false)
  })

  it("an unqualified milk query does not accept the unpasteurised record, whatever state claims", () => {
    // BLS labels the raw-milk record correctly; the query's "raw" is the classifier's null value
    // (#47). The gate must not be reachable through it, so both state claims must agree.
    const base = {
      structuredName: "Milch", canonicalGerman: "Milch", canonicalEnglish: "milk", coreFood: "Milch",
    } as const
    const winner = blsRecord("Vollmilch frisch, 3,5 % Fett, pasteurisiert")
    const raw = blsRecord("Rohmilch/Vorzugsmilch, mind. 3,5 % Fett")

    expect(rerankPreservesIdentity(query({ ...base, state: "raw" }), winner, raw)).toBe(false)
    expect(rerankPreservesIdentity(query({ ...base, state: "unknown" }), winner, raw)).toBe(false)
  })
})

describe("BLS and USDA are protected by the same rule", () => {
  it("the verdict does not depend on which provider asked", () => {
    const winner = candidate(["alpha", "beta"])
    const destructive = candidate(["alpha", "gamma", "betaform"])
    const base = {
      structuredName: "Alphabeta", canonicalGerman: "Alphabeta",
      canonicalEnglish: "alpha beta", coreFood: "Alpha",
    } as const

    for (const provider of ["bls", "usda-local"]) {
      expect(rerankPreservesIdentity(query({ ...base, provider }), winner, destructive)).toBe(false)
      expect(rerankPreservesIdentity(query({ ...base, provider }), null, destructive)).toBe(true)
    }
  })
})

describe("nothing else in the rerank contract moves", () => {
  it("identityKey still collapses token order, so same-identity rejection is unchanged", () => {
    expect(identityKey(["beta", "alpha"])).toBe(identityKey(["alpha", "beta"]))
    expect(identityKey(["alpha"])).not.toBe(identityKey(["alpha", "beta"]))
  })

  it("the reply parser still refuses anything it cannot trust", () => {
    const offered: RerankCandidate[] = [
      { providerId: "A", productName: "a", kcalPer100g: 1, form: "unknown", preservation: "unknown", score: 50 },
      { providerId: "B", productName: "b", kcalPer100g: 2, form: "unknown", preservation: "unknown", score: 40 },
    ]

    // NONE, a hallucinated index, and a missing confidence all behave as before.
    expect(parseRerankReply('{"selected":null,"confidence":0.9,"reason":"x"}', offered)?.providerId).toBeNull()
    expect(parseRerankReply('{"selected":7,"confidence":0.9,"reason":"x"}', offered)).toBeNull()
    expect(parseRerankReply('{"selected":1,"reason":"x"}', offered)).toBeNull()
    // The confidence itself is passed through untouched — the threshold is applied elsewhere.
    expect(parseRerankReply('{"selected":2,"confidence":0.42,"reason":"x"}', offered))
      .toEqual({ providerId: "B", confidence: 0.42, reason: "x" })
  })
})
