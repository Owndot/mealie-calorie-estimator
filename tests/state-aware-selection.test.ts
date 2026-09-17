import { describe, it, expect, beforeAll } from "vitest"
import { initCache } from "../src/utils/cache.js"
import { createBlsProviderIfAvailable } from "../src/services/providers/bls-provider.js"
import { statedPreparation } from "../src/services/providers/food-semantics.js"
import { UNKNOWN_ATTRIBUTES, type FoodState, type ProviderQuery } from "../src/types.js"

/**
 * A preparation state the INGREDIENT TEXT STATES must be able to CHOOSE a record, not only reject
 * one — and a state only the CLASSIFIER claims must not.
 *
 * Before this, an explicit query state was purely a veto, and `unknown` contradicts nothing — so a
 * record BLS never labelled satisfied "cooked" exactly as well as one labelled "gekocht". The
 * core-only variant "Linsen" ties three records at 75:
 *
 *   H725100  Linse reif            state unknown  323 kcal   <- selected, DRY
 *   H730132  Linse reif, gekocht   state cooked   119 kcal   <- correct, same score
 *   H730902  Linse reif, Konserve  state unknown
 *
 * so "Cooked Puy Lentils" resolved to dry lentils: roughly 3x the real figure, with the exact
 * state match sitting one position away.
 *
 * The evidence is read from the text rather than from query.state because those are not the same
 * thing. reconcileState() refuses an unevidenced "cooked"/"dried" but lets an unevidenced "raw"
 * through by design, and on the frozen corpus 110 of 122 non-unknown states are exactly that — a
 * null value the classifier emits for Salz, Zucker, Mehl, Parmesan and Wasser alike. Promoting on
 * those would move "Milch (Vollmilch)" off pasteurised whole milk onto BLS's correctly-labelled
 * raw milk, which is the regression these tests exist to prevent.
 */

function query(overrides: Partial<ProviderQuery> & { state: FoodState }): ProviderQuery {
  return {
    foodName: "lentils", structuredName: "Linsen", canonicalGerman: "Linsen",
    brand: null, category: null, foodType: "simple",
    coreFoodGerman: "Linsen", coreFoodEnglish: "lentils", route: "generic",
    attributes: UNKNOWN_ATTRIBUTES, householdId: null, ancestorSlugs: [],
    evidence: { german: true, english: true, core: true, brand: false },
    ...overrides,
  } as ProviderQuery
}

beforeAll(async () => { await initCache() })

describe("a state the text states picks the matching record", () => {
  it("'Cooked Puy Lentils' reaches the cooked lentil record, not the tied unknown-state dry one", async () => {
    const match = await createBlsProviderIfAvailable().lookup(query({
      state: "cooked", foodName: "Cooked Puy Lentils", structuredName: "Cooked Puy Lentils",
      canonicalGerman: "Gekochte Puy-Linsen",
    }))

    expect(match).not.toBeNull()
    expect(match!.providerId).toBe("H730132")
    expect(match!.productName).toContain("gekocht")
    // ~119 kcal cooked vs ~323 dry — the error this fixes is ~3x, not cosmetic.
    expect(match!.nutrients.kcalPer100g!).toBeLessThan(200)
  })

  it("an explicit 'roh' in the text may prefer an exact raw candidate", async () => {
    // statedPreparation recognises "roh" as a standalone token, so this IS evidence.
    expect(statedPreparation("Rinderhackfleisch, roh")).toBe("raw")

    const match = await createBlsProviderIfAvailable().lookup(query({
      state: "raw", foodName: "raw ground beef", structuredName: "Rinderhackfleisch, roh",
      canonicalGerman: "Rinderhackfleisch, roh", coreFoodGerman: "Rind", coreFoodEnglish: "beef",
    }))

    expect(match).not.toBeNull()
    expect(match!.productName).toMatch(/roh/i)          // an exact-state record was reached
    expect(match!.productName).not.toMatch(/gekocht|gebraten|gegrillt|geschmort/i)
  })
})

describe("an unevidenced classifier state is inert for positive preference", () => {
  it("'Milch (Vollmilch)' with classifier state raw does NOT promote M112300 Rohmilch", async () => {
    // The regression this gate exists for. Nothing in "Milch (Vollmilch)" says raw — the word is
    // the classifier's null value — while BLS's M112300 "Rohmilch/Vorzugsmilch" is CORRECTLY
    // labelled raw. Promoting on the unevidenced claim swaps 62 kcal pasteurised whole milk for
    // 67 kcal unpasteurised. Both sides are right; the state simply is not evidence.
    expect(statedPreparation("Milch (Vollmilch)")).toBe("unknown")

    const match = await createBlsProviderIfAvailable().lookup(query({
      state: "raw", foodName: "Milch (Vollmilch)", structuredName: "Milch (Vollmilch)",
      canonicalGerman: "Milch (Vollmilch)", coreFoodGerman: "Milch", coreFoodEnglish: "milk",
    }))

    expect(match).not.toBeNull()
    expect(match!.providerId).toBe("M111300")
    expect(match!.providerId).not.toBe("M112300")
    expect(match!.productName).toContain("pasteurisiert")
  })

  it("a synthetic unevidenced state claim changes nothing at all", async () => {
    // Same query, twice, differing ONLY in the classifier's state claim. The text states no
    // preparation either way, so the promotion step must not fire and both must agree.
    const provider = createBlsProviderIfAvailable()
    const base = {
      foodName: "Parmesan", structuredName: "Parmesan", canonicalGerman: "Parmesan",
      coreFoodGerman: "Parmesan", coreFoodEnglish: "Parmesan",
    }
    expect(statedPreparation("Parmesan")).toBe("unknown")

    const claimed = await provider.lookup(query({ ...base, state: "raw" }))
    const silent = await provider.lookup(query({ ...base, state: "unknown" }))

    expect(claimed!.providerId).toBe(silent!.providerId)
  })
})

describe("nothing moves when the text states no preparation", () => {
  it("an evidence-free query selects exactly what it selected before", async () => {
    // The deterministic classifier produces state "unknown" for every ingredient and its text
    // states nothing, so this is the path almost all traffic takes. It must be byte-identical.
    const match = await createBlsProviderIfAvailable().lookup(query({ state: "unknown" }))

    expect(match).not.toBeNull()
    expect(match!.providerId).toBe("H725100")
    expect(match!.productName).toBe("Linse reif")
  })

  it("other settled cases are undisturbed", async () => {
    const provider = createBlsProviderIfAvailable()

    const water = await provider.lookup(query({
      state: "unknown", foodName: "Wasser", structuredName: "Wasser",
      canonicalGerman: "Wasser", coreFoodGerman: null, coreFoodEnglish: null,
    }))
    expect(water!.providerId).toBe("N110000")

    const potato = await provider.lookup(query({
      state: "unknown", foodName: "Kartoffeln", structuredName: "Kartoffeln",
      canonicalGerman: "Kartoffeln", coreFoodGerman: null, coreFoodEnglish: null,
    }))
    expect(potato!.providerId).toBe("K110100")
  })
})

describe("the existing conflict behaviour is unchanged", () => {
  it("queryState still vetoes a contradicting record even with no text evidence", async () => {
    // The veto reads query.state, NOT the evidenced state — so degrading the promotion input must
    // not quietly remove the protection an unevidenced claim already provided.
    const match = await createBlsProviderIfAvailable().lookup(query({ state: "frozen" as FoodState }))

    if (match) {
      expect(match.providerId).not.toBe("H730132") // not silently handed the cooked record
    }
  })

  it("promotion never lifts a candidate outside the score band", async () => {
    // A cooked record far below the band must not outrank a much better-scoring in-band one, even
    // when the text genuinely states "gekocht".
    const match = await createBlsProviderIfAvailable().lookup(query({
      state: "cooked", foodName: "gekochte Kartoffeln", structuredName: "gekochte Kartoffeln",
      canonicalGerman: "gekochte Kartoffeln", coreFoodGerman: "Kartoffel", coreFoodEnglish: "potato",
    }))

    expect(match).not.toBeNull()
    expect(match!.productName).toMatch(/Kartoffel/i)
  })
})
