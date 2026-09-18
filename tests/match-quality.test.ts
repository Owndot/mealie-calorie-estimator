import { describe, it, expect } from "vitest"
import { classifyMatchQuality, buildNutritionPatch } from "../src/services/estimator.js"
import type { EstimateResult, IngredientMatch, NutrientSet } from "../src/types.js"

/**
 * COVERAGE vs MATCH QUALITY.
 *
 * `calorie_estimator_status` answers "did everything resolve?". It answered "complete" for all
 * three validated recipes while generic pasta had become rice noodles, plain mustard had become
 * sweet mustard and 400 g of canned beans had become a prepared survey entry — every ingredient
 * matched, so coverage really was complete and the number still was not trustworthy. Quality is
 * therefore reported on its own axis, and weighted by calories rather than by ingredient count.
 */
const nutrients = (kcal: number | null): NutrientSet => ({
  kcalPer100g: kcal, proteinPer100g: null, carbsPer100g: null, fatPer100g: null,
  saturatedFatPer100g: null, transFatPer100g: null, unsaturatedFatPer100g: null,
  fiberPer100g: null, sugarPer100g: null, sodiumPer100g: null, cholesterolPer100g: null,
})

const ing = (name: string, kcalPer100g: number | null, grams: number, confidence: number | null, extra: Partial<IngredientMatch> = {}): IngredientMatch => ({
  name, canonicalName: name, brand: null, route: "generic", grams, gramsEstimated: false,
  matched: true, nutrients: nutrients(kcalPer100g), provider: "bls", providerId: "X", productName: `${name} record`,
  confidence, fallbackStatus: "bls", llmParticipated: false, ...extra,
})

describe("match quality is weighted by calories, not by ingredient count", () => {
  it("a confident recipe grades high", () => {
    const q = classifyMatchQuality([ing("Reis", 351, 100, 0.92), ing("Öl", 899, 27, 0.92)])
    expect(q.matchQuality).toBe("high")
    expect(q.lowConfidence).toEqual([])
  })

  it("one doubtful ingredient carrying most of the calories cannot be averaged away", () => {
    // The live curry shape: twelve confident trimmings and one 400 g bean match at 0.55.
    const trimmings = ["Knoblauch", "Ingwer", "Limette", "Tomate", "Zwiebel"].map((n) => ing(n, 30, 50, 0.92))
    const q = classifyMatchQuality([...trimmings, ing("Kidneybohnen a. d. Dose", 177, 400, 0.55)])
    expect(q.matchQuality).not.toBe("high")
    expect(q.reason).toMatch(/Kidneybohnen/)
    expect(q.reason).toMatch(/% of the calories/)
    expect(q.lowConfidence).toContain("Kidneybohnen a. d. Dose")
  })

  it("the same doubtful match on a pinch of spice does not drag the recipe down", () => {
    const q = classifyMatchQuality([ing("Reis", 351, 300, 0.92), ing("Pfeffer", 251, 0.4, 0.35)])
    expect(q.matchQuality).toBe("high")
    // It is still reported individually — graded low, listed either way.
    expect(q.lowConfidence).toEqual(["Pfeffer"])
  })

  it("an all-LLM recipe grades low", () => {
    const q = classifyMatchQuality([ing("Curry", 325, 20, 0.35), ing("Gewürzpaste", 200, 30, 0.35)])
    expect(q.matchQuality).toBe("low")
  })

  it("a recipe with no energy-bearing match reports low rather than silently high", () => {
    expect(classifyMatchQuality([ing("Salz", null, 3, 0.92)]).matchQuality).toBe("low")
  })

  it("zero-calorie ingredients do not divide by zero", () => {
    const q = classifyMatchQuality([ing("Salz", 0, 3, 0.92), ing("Wasser", 0, 500, 0.92)])
    expect(q.matchQuality).toBe("high")
  })
})

describe("the two axes are reported separately and additively", () => {
  const result = (over: Partial<EstimateResult>): EstimateResult => ({
    slug: "s", servings: 2, totalNutrients: nutrients(1000), perServingNutrients: nutrients(500),
    matchedCount: 2, unmatchedCount: 0, unmatchedIngredients: [], matchedIngredients: [],
    completeness: "complete", completenessReason: null,
    matchQuality: "high", matchQualityReason: null, lowConfidenceIngredients: [],
    evidence: "database", estimatedKcalShare: 0, databaseKcalShare: 1, unresolvedWeightShare: 0, ...over,
  })

  it("keeps calorie_estimator_status's existing values untouched", () => {
    const extras = buildNutritionPatch(result({}), "h", null).extras
    expect(extras.calorie_estimator_status).toBe("complete")
  })

  it("a complete recipe may still be reported as poorly matched", () => {
    const extras = buildNutritionPatch(result({
      matchQuality: "mixed", matchQualityReason: "\"Nudeln\" contributes 41% of the calories from a low-confidence match",
      lowConfidenceIngredients: ["Nudeln", "Senf"],
    }), "h", null).extras
    expect(extras.calorie_estimator_status).toBe("complete")
    expect(extras.calorie_estimator_match_quality).toBe("mixed")
    expect(extras.calorie_estimator_match_quality_reason).toMatch(/Nudeln/)
    expect(JSON.parse(extras.calorie_estimator_low_confidence)).toEqual(["Nudeln", "Senf"])
  })

  it("omits the optional keys when there is nothing to say", () => {
    const extras = buildNutritionPatch(result({}), "h", null).extras
    expect(extras.calorie_estimator_match_quality).toBe("high")
    expect(extras.calorie_estimator_low_confidence).toBeUndefined()
    expect(extras.calorie_estimator_match_quality_reason).toBeUndefined()
  })
})
