import { describe, it, expect } from "vitest"
import {
  compoundMatchesTokens, compoundIdentityModifier, germanStem, germanTokenMatches,
  formConflict, preservationConflict, fatConflict, fatApproximate, freshVsProcessedFormConflict,
  inferAttributesFromName, attributesKey,
  compoundSpecifier, absenceMarkerStem, derivedProductConflict, standalonePlantPart,
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

describe("candidate-side sub-variety detection (compoundSpecifier)", () => {
  const D = new Set<string>()

  it("flags a compound prefix that names something the query never asked for", () => {
    // German is right-headed, so "Reisnudeln" really IS a kind of "Nudeln" — which is the problem:
    // containment scored rice noodles as if they were plain pasta.
    expect(compoundSpecifier("reisnudeln", "nudeln", D)).toBe("reis")
    expect(compoundSpecifier("eierteigwaren", "teigwaren", D)).toBe("eier")
    expect(compoundSpecifier("halbfettbutter", "butter", D)).toBe("halbfett")
    expect(compoundSpecifier("wurzelpetersilie", "petersilie", D)).toBe("wurzel")
  })

  it("does not flag the core itself, an inflection of it, or a descriptor prefix", () => {
    expect(compoundSpecifier("nudeln", "nudeln", D)).toBeNull()
    expect(compoundSpecifier("kidneybohnen", "kidneybohne", D)).toBeNull() // regular plural
    expect(compoundSpecifier("speisezwiebel", "zwiebel", D)).toBeNull()    // descriptor + linking -e
    expect(compoundSpecifier("speisesalz", "salz", D)).toBeNull()
    expect(compoundSpecifier("vollmilch", "milch", D)).toBeNull()
    expect(compoundSpecifier("teigwaren", "waren", D)).toBe("teig")        // sanity: a real prefix IS flagged
  })

  it("only reads the core as the compound HEAD, never anywhere else in the token", () => {
    // German identity lives in the head; "Zwiebelsuppe" is a soup, not a narrower onion, and is
    // left to the composite-dish gates rather than being mistaken for a sub-variety.
    expect(compoundSpecifier("zwiebelsuppe", "zwiebel", D)).toBeNull()
  })

  it("respects a caller-supplied descriptor vocabulary as well as the German one", () => {
    expect(compoundSpecifier("organicbutter", "butter", new Set(["organic"]))).toBeNull()
  })
})

describe("'free-from' markers are absences, not added foods", () => {
  it("reads the excluded ingredient out of the marker", () => {
    // BLS's plain durum pasta is literally named "Teigwaren eifrei" — egg-FREE — and the
    // foreign-content penalty on that word was the only reason it lost to the egg pasta.
    expect(absenceMarkerStem("eifrei")).toBe("ei")
    expect(absenceMarkerStem("glutenfrei")).toBe("gluten")
    expect(absenceMarkerStem("laktosefrei")).toBe("laktose")
    expect(absenceMarkerStem("gluten-free")).toBe("gluten")
  })

  it("never neutralises the removal of an energy-bearing component", () => {
    // Sugar-free and alcohol-free products ARE nutritionally different, whatever the query said.
    expect(absenceMarkerStem("zuckerfrei")).toBeNull()
    expect(absenceMarkerStem("alkoholfrei")).toBeNull()
    expect(absenceMarkerStem("fettfrei")).toBeNull()
  })

  it("ignores words that merely end in the same letters", () => {
    expect(absenceMarkerStem("brei")).toBeNull()
    expect(absenceMarkerStem("frei")).toBeNull()
  })
})

describe("derived products (seasoning / brine / juice / powder) are their own identity", () => {
  it("rejects the raw whole food for a query that named a derived product", () => {
    expect(derivedProductConflict("Knoblauchgewürz", "Knoblauch", "Knoblauch roh")).toBe(true)
    expect(derivedProductConflict("garlic seasoning", "garlic", "Garlic, raw")).toBe(true)
    expect(derivedProductConflict("Gurkenwasser", "Gurke", "Gurke roh")).toBe(true)
    expect(derivedProductConflict("pickle brine", "pickle", "Pickles, NFS")).toBe(true)
  })

  it("accepts a DIFFERENT word for the same derived class", () => {
    // A garlic seasoning legitimately resolves to a garlic powder record; both are preparations.
    expect(derivedProductConflict("Knoblauchgewürz", "Knoblauch", "Knoblauch Pulver")).toBe(false)
    expect(derivedProductConflict("garlic seasoning", "garlic", "Spices, garlic powder")).toBe(false)
  })

  it("never fires for a query that is not a derived product", () => {
    expect(derivedProductConflict("Knoblauch", "Knoblauch", "Knoblauch roh")).toBe(false)
    expect(derivedProductConflict("Basmati-Reis", "Reis", "Reis poliert, roh")).toBe(false)
  })

  it("is satisfied by the candidate alone, so a query that IS the derived product still resolves", () => {
    // Deliberately not exempted via the core: that exemption vanished the moment the classifier
    // failed to strip the modifier. These pass because the right candidates carry a marker too.
    expect(derivedProductConflict("Tomatenmark", "Tomatenmark", "Tomatenmark")).toBe(false)
    expect(derivedProductConflict("Wasser", "Wasser", "Trinkwasser")).toBe(false)
    expect(derivedProductConflict("Gemüsebrühe", "Brühe", "Gemüsebrühe")).toBe(false)
  })
})

describe("plant parts are only read from standalone words", () => {
  it("recognises a part named as its own word", () => {
    expect(standalonePlantPart("Spices, coriander seed")).toBe("seed")
    expect(standalonePlantPart("Coriander (cilantro) leaves, raw")).toBe("leaf")
    expect(standalonePlantPart("Petersilie Wurzel")).toBe("root")
  })

  it("does not read a part out of a fused compound that names the food itself", () => {
    // "Sesamsamen" IS sesame; "Sonnenblumenkerne" IS sunflower seeds. Treating those as narrowing
    // would reject foods whose only database form is the seed.
    expect(standalonePlantPart("Sesamsamen")).toBeNull()
    expect(standalonePlantPart("Sonnenblumenkerne geschält")).toBeNull()
    expect(standalonePlantPart("Korianderblätter")).toBeNull()
  })
})

describe("attribute inference reads the name as written", () => {
  it("handles inflected German adjectives", () => {
    expect(inferAttributesFromName("Getrocknete Tomate").preservation).toBe("dried")
    expect(inferAttributesFromName("getrockneter Thymian").preservation).toBe("dried")
  })

  it("takes the FIRST preservation word when a name carries two", () => {
    // Dried tomatoes packed in oil in a jar are a DRIED product; BLS states the primary
    // transformation first, so reading in name order beats reading in marker-table order.
    expect(inferAttributesFromName("Tomate getrocknet, in Öl, Konserve, abgetropft").preservation).toBe("dried")
    expect(inferAttributesFromName("Kidneybohne reif, Konserve, abgetropft").preservation).toBe("canned")
  })

  it("keeps canned apart from fresh, while staying permissive about silence", () => {
    // "Thunfisch a. d. Dosen" took BLS's raw tuna because canned-vs-fresh was not a conflict.
    expect(preservationConflict("canned", "fresh")).toBe(true)
    expect(preservationConflict("canned", "unknown")).toBe(false)
  })
})
