import { describe, it, expect, vi, beforeEach, beforeAll, afterEach } from "vitest"
import { config } from "../src/config.js"
import { initCache } from "../src/utils/cache.js"
import {
  estimateRecipe, buildNutritionPatch, evidenceClassFor, EVIDENCE_ESTIMATED_KCAL_SHARE,
} from "../src/services/estimator.js"
import type { MealieRecipe, MealieIngredient } from "../src/types.js"

/**
 * The evidence axis: WHERE a recipe's calories came from, kept deliberately independent of
 * Completeness, which remains COVERAGE-only.
 *
 * Conflating the two was the mistake this design avoids — and types.ts already warned about it for
 * MatchQuality. Keeping them separate is what lets `Protein-Waffeln` be honestly reported as
 * `partial` coverage AND `estimated` evidence at the same time, instead of the coverage label
 * silently masking the fact that 37% of its calories are model-generated.
 */

function ing(quantity: number, name: string, unitName = "g"): MealieIngredient {
  return {
    quantity,
    unit: { id: unitName, name: unitName, pluralName: unitName, abbreviation: null, standardQuantity: null, standardUnit: null },
    food: { id: name, name, pluralName: null, aliases: [] },
    note: null, display: `${quantity} ${unitName} ${name}`, title: null,
    originalText: `${quantity} ${unitName} ${name}`,
  }
}

function recipe(ingredients: MealieIngredient[], servings = 2): MealieRecipe {
  return {
    slug: "evidence-test", name: "evidence-test", recipeYield: null, recipeServings: servings,
    recipeIngredient: ingredients, nutrition: null, tags: [], extras: {}, householdId: null,
  }
}

/** Forces the LLM nutrient fallback to answer, so an ingredient resolves as `llm-nutrient`. */
function stubLlmNutrients(kcal: number): void {
  config.llm.enabled = true
  config.llm.apiKey = "test-key"
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
    const body = JSON.parse((init as RequestInit).body as string)
    const prompt = body.messages[0].content as string
    if (prompt.includes("Return ONLY a JSON array")) {
      // A VALID batch response: an empty array fails validation, retries, and exhausts the rate
      // limiter before the nutrient call — simulating a broken LLM, not a working one.
      const names = [...prompt.matchAll(/"([^"]+)"/g)].map((m) => m[1])
      const items = names.map((_n, index) => ({
        index, canonicalName: "unknown food", brand: null, state: "raw", category: null,
      }))
      return new Response(
        JSON.stringify({ choices: [{ message: { content: JSON.stringify(items) } }] }), { status: 200 })
    }
    // Macros must be self-consistent with kcal by Atwater, or sanityCheckNutrients rejects the
    // estimate and the ingredient goes unresolved — which is the resolver working as intended.
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        kcal,
        protein: (kcal * 0.1) / 4,
        carbs: (kcal * 0.4) / 4,
        fat: (kcal * 0.5) / 9,
        saturatedFat: 0, transFat: 0, fiber: 0, sugar: 0, sodium: 0, cholesterol: 0,
      }) } }],
    }), { status: 200 })
  })
}

beforeAll(async () => { await initCache() })

beforeEach(() => {
  config.llm.enabled = false
  config.llm.apiKey = ""
  config.llm.judgeEnabled = false
})

afterEach(() => { vi.restoreAllMocks() })

describe("evidenceClassFor is the single extension point", () => {
  it("only llm-nutrient is estimated evidence", () => {
    expect(evidenceClassFor("llm-nutrient")).toBe("estimated")
  })

  it("every real record source is database evidence", () => {
    for (const p of ["bls", "usda-local", "off", "mealie-recipe"]) {
      expect(evidenceClassFor(p)).toBe("database")
    }
  })

  it("an override reports its underlying provider, so it classifies as database", () => {
    // override-provider.ts deliberately sets `provider` to the REAL source and records the
    // override only as matchReason — so no special case is needed here, now or for custom foods.
    expect(evidenceClassFor("bls")).toBe("database")
    expect(evidenceClassFor("off")).toBe("database")
  })

  it("an unknown future provider defaults to database rather than silently estimated", () => {
    expect(evidenceClassFor("some-future-provider")).toBe("database")
  })
})

describe("the classification threshold is a single named policy constant", () => {
  it("is 0.25 and is exported rather than scattered as a literal", () => {
    expect(EVIDENCE_ESTIMATED_KCAL_SHARE).toBe(0.25)
  })
})

describe("a fully database-backed recipe", () => {
  it("reports database evidence, share 0 and database share 1", async () => {
    const result = await estimateRecipe(recipe([ing(500, "Kartoffeln"), ing(200, "Karotten")]))

    expect(result.evidence).toBe("database")
    expect(result.estimatedKcalShare).toBe(0)
    expect(result.databaseKcalShare).toBe(1)
    // Coverage is untouched by any of this.
    expect(result.completeness).toBe("complete")
  })

  it("writes the shares as decimal strings in the extras", async () => {
    const result = await estimateRecipe(recipe([ing(500, "Kartoffeln")]))
    const patch = buildNutritionPatch(result, "hash", null)

    expect(patch.extras.calorie_estimator_evidence).toBe("database")
    expect(patch.extras.calorie_estimator_estimated_kcal_share).toBe("0.0000")
    expect(patch.extras.calorie_estimator_database_kcal_share).toBe("1.0000")
    expect(patch.extras.calorie_estimator_unresolved_weight_share).toBe("0.0000")
  })
})

describe("a recipe with model-generated calories", () => {
  it("counts only llm-nutrient toward the estimated share", async () => {
    stubLlmNutrients(500)
    // 100 g of a food no database knows -> llm-nutrient; 100 g Kartoffeln -> bls.
    const result = await estimateRecipe(recipe([ing(100, "Quiznuggets vom Mond"), ing(100, "Kartoffeln")]))

    const llm = result.matchedIngredients.find((i) => i.provider === "llm-nutrient")
    expect(llm, "the fallback must have produced an llm-nutrient match").toBeTruthy()

    expect(result.estimatedKcalShare).toBeGreaterThan(0)
    expect(result.estimatedKcalShare! + result.databaseKcalShare!).toBeCloseTo(1, 6)
    expect(result.evidence).toBe("estimated") // 500 kcal vs 83 kcal -> well above 25%
  })

  it("does not escalate when the estimated share is small", async () => {
    stubLlmNutrients(10)
    // 5 g of a 10 kcal/100g estimate against 1000 g of potato: a negligible share.
    const result = await estimateRecipe(recipe([ing(5, "Quiznuggets vom Mond"), ing(1000, "Kartoffeln")]))

    expect(result.estimatedKcalShare!).toBeLessThan(EVIDENCE_ESTIMATED_KCAL_SHARE)
    expect(result.evidence).toBe("mixed")
    // `mixed` must NOT be read as database-backed — the raw share is what carries the truth.
    expect(result.estimatedKcalShare!).toBeGreaterThan(0)
  })
})

describe("null is never conflated with zero", () => {
  it("a recipe with no computable calories reports null shares, not 0", async () => {
    // Water and salt: both resolve to real records, both 0 kcal -> total contribution is 0.
    const result = await estimateRecipe(recipe([ing(500, "Wasser"), ing(5, "Salz")]))

    expect(result.estimatedKcalShare).toBeNull()
    expect(result.databaseKcalShare).toBeNull()
    // Classified on the CONTRIBUTION, not the share: no estimated calories is still true.
    expect(result.evidence).toBe("database")
  })

  it("omits the share extras entirely when they are null, rather than writing \"0\"", async () => {
    const result = await estimateRecipe(recipe([ing(500, "Wasser"), ing(5, "Salz")]))
    const patch = buildNutritionPatch(result, "hash", null)

    expect(patch.extras.calorie_estimator_estimated_kcal_share).toBeUndefined()
    expect(patch.extras.calorie_estimator_database_kcal_share).toBeUndefined()
    // The unresolved-weight share is always computable, so it is always written.
    expect(patch.extras.calorie_estimator_unresolved_weight_share).toBe("0.0000")
    expect(patch.extras.calorie_estimator_evidence).toBe("database")
  })
})

describe("the two axes are independent", () => {
  it("coverage stays complete while evidence reports estimated", async () => {
    stubLlmNutrients(500)
    const result = await estimateRecipe(recipe([ing(100, "Quiznuggets vom Mond"), ing(100, "Kartoffeln")]))

    expect(result.completeness).toBe("complete")   // every ingredient resolved
    expect(result.evidence).toBe("estimated")      // but the calories are mostly generated
  })

  it("an unresolved ingredient still drives coverage, independently of evidence", async () => {
    // No LLM: the unknown food cannot resolve at all.
    const result = await estimateRecipe(recipe([ing(300, "Kartoffeln"), ing(200, "Quiznuggets vom Mond")]))

    expect(result.completeness).toBe("withheld")   // 40% of known weight unresolved
    expect(result.unresolvedWeightShare).toBeCloseTo(0.4, 4)
    expect(result.evidence).toBe("database")       // nothing estimated contributed
  })
})

describe("nothing else moves", () => {
  it("the nutrition fingerprint is unaffected by the new extras", async () => {
    const result = await estimateRecipe(recipe([ing(500, "Kartoffeln")]))
    const patch = buildNutritionPatch(result, "hash", null)

    // The fingerprint covers the nutrition object only. If the new extras perturbed it, every
    // existing recipe would look manually modified on its next run.
    const { computeNutritionFingerprint } = await import("../src/services/nutrition-format.js")
    expect(patch.extras.calorie_estimator_nutrition_fingerprint)
      .toBe(computeNutritionFingerprint(patch.nutrition!))
  })

  it("coverage status and manual ownership are written exactly as before", async () => {
    const result = await estimateRecipe(recipe([ing(500, "Kartoffeln")]))
    const patch = buildNutritionPatch(result, "hash", null)

    expect(patch.extras.calorie_estimator_status).toBe("complete")
    expect(patch.extras.calorie_estimator_manual).toBe("false")
  })
})
