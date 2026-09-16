import { describe, it, expect } from "vitest"
import {
  compoundMatchesTokens, compoundIdentityModifier, germanStem, germanTokenMatches,
  formConflict, preservationConflict, fatConflict, fatApproximate, freshVsProcessedFormConflict,
  inferAttributesFromName, attributesKey,
} from "../../src/services/providers/food-semantics.js"

// These encode the general linguistic/semantic rules the manual recipe testing exposed. They are
// deliberately expressed as RULES over many words, not as assertions about the specific
// ingredients that happened to fail, so a regression shows up as "the mechanism broke" rather than
// "one food changed".

describe("German descriptive vs identity-changing modifiers", () => {
  it("treats an identity modifier fused into a compound as extra content, not a synonym", () => {
    // "Halbfettbutter" contains "butter", which made it look like a fully-explained plain butter
    // and let it outscore the correct record. Same shape for other reduced-fat compounds.
    expect(compoundIdentityModifier("halbfettbutter", "butter")).toBe("halbfett")
    expect(compoundIdentityModifier("magerquark", "quark")).toBe("mager")
    expect(compoundIdentityModifier("fettarmemilch", "milch")).toBeTruthy()
  })

  it("does not flag an ordinary compound that merely qualifies the same food", () => {
    expect(compoundIdentityModifier("speisezwiebel", "zwiebel")).toBeNull()
    expect(compoundIdentityModifier("suessrahmbutter", "butter")).toBeNull()
    expect(compoundIdentityModifier("butter", "butter")).toBeNull()
  })
})

describe("German compound segmentation", () => {
  it("matches a fused query compound against a record that spells the parts out", () => {
    expect(compoundMatchesTokens("haehnchenbrust", ["haehnchen", "brustfilet", "roh"])).toBe(true)
    // linking morpheme: Rind + ER + hackfleisch
    expect(compoundMatchesTokens("rinderhackfleisch", ["rind", "hackfleisch", "roh"])).toBe(true)
    expect(compoundMatchesTokens("schweinebauch", ["schwein", "bauch", "roh"])).toBe(true)
    expect(compoundMatchesTokens("kalbsleber", ["kalb", "leber", "roh"])).toBe(true)
  })

  it("does not match when only one half is evidenced", () => {
    expect(compoundMatchesTokens("haehnchenbrust", ["haehnchen", "schenkel"])).toBe(false)
    expect(compoundMatchesTokens("rinderhackfleisch", ["rind", "filet"])).toBe(false)
  })

  it("never treats a bare repeated token as compound evidence (dish-name guard)", () => {
    // "Koriander" inside "Rote-Linsensuppe mit Koriander" is not compounding.
    expect(compoundMatchesTokens("koriander", ["rote", "linsensuppe", "mit", "koriander"])).toBe(false)
  })

  it("requires both sides to be substantial — a one-letter record token proves nothing", () => {
    // BLS parenthesises carcass grades like "(S X)"; a bare "x" must not prefix-match anything.
    expect(compoundMatchesTokens("basmatireis", ["s", "x"])).toBe(false)
  })
})

describe("German plural tolerance", () => {
  it("treats regular -n/-en/-e plurals as the same word", () => {
    expect(germanTokenMatches("kidneybohnen", "kidneybohne")).toBe(true)
    expect(germanTokenMatches("tomaten", "tomate")).toBe(true)
    expect(germanStem("kidneybohnen")).toBe(germanStem("kidneybohne"))
  })

  it("does not collapse short or unrelated words", () => {
    expect(germanTokenMatches("reis", "reise")).toBe(false) // both too short to strip
    expect(germanTokenMatches("butter", "zwiebel")).toBe(false)
  })
})

describe("form / preservation / fat conflicts", () => {
  it("reads form and preservation only from words actually present", () => {
    expect(inferAttributesFromName("Ingwer, frisch").preservation).toBe("fresh")
    expect(inferAttributesFromName("Spices, ginger, ground").form).toBe("ground")
    expect(inferAttributesFromName("Korianderblätter").form).toBe("leaf")
    expect(inferAttributesFromName("Koriandersamen").form).toBe("seed")
    expect(inferAttributesFromName("Kidneybohne reif, Konserve, abgetropft").preservation).toBe("canned")
    // A bare, genuinely ambiguous ingredient stays unknown — we never invent precision.
    expect(inferAttributesFromName("Koriander")).toMatchObject({ form: "unknown", preservation: "unknown" })
    expect(inferAttributesFromName("Ingwer").form).toBe("unknown")
  })

  it("rejects leaf-vs-seed and whole-vs-ground, and stays permissive when unknown", () => {
    expect(formConflict("leaf", "seed")).toBe(true)
    expect(formConflict("whole", "ground")).toBe(true)
    expect(formConflict("unknown", "ground")).toBe(false) // ambiguity must not hard-reject
    expect(formConflict("ground", "ground")).toBe(false)
  })

  it("rejects a ground spice for an explicitly FRESH ingredient (cross-axis)", () => {
    // Neither single axis fires here: "Spices, ginger, ground" carries no preservation word.
    expect(freshVsProcessedFormConflict("fresh", "ground")).toBe(true)
    expect(freshVsProcessedFormConflict("fresh", "powder")).toBe(true)
    expect(freshVsProcessedFormConflict("unknown", "ground")).toBe(false)
  })

  it("rejects canned-vs-dried but allows canned-vs-cooked", () => {
    expect(preservationConflict("canned", "dried")).toBe(true)
    expect(preservationConflict("fresh", "dried")).toBe(true)
    expect(preservationConflict("canned", "unknown")).toBe(false)
  })

  it("keeps fat classes apart without interpolating nutrients", () => {
    // 15% cooking cream must not become 30% cream; tolerance is max(2pp, 15% relative).
    expect(fatConflict(15, 31.7)).toBe(true)
    expect(fatConflict(15, 10)).toBe(true)
    expect(fatConflict(7, 10)).toBe(true)
    expect(fatConflict(30, 31.7)).toBe(false)
    expect(fatConflict(null, 31.7)).toBe(false) // no request -> no constraint
    expect(fatApproximate(30, 31.7)).toBe(true) // within tolerance but not exact -> recorded
  })

  it("keeps semantically different states apart in the cache identity", () => {
    const fresh = attributesKey({ form: "whole", preservation: "fresh", fatPercent: null })
    const ground = attributesKey({ form: "ground", preservation: "dried", fatPercent: null })
    const cream7 = attributesKey({ form: "unknown", preservation: "unknown", fatPercent: 7 })
    const cream15 = attributesKey({ form: "unknown", preservation: "unknown", fatPercent: 15 })
    expect(new Set([fresh, ground, cream7, cream15]).size).toBe(4)
  })
})
