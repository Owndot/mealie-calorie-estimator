import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest"
import { config } from "../src/config.js"
import { initCache, clearLlmCache } from "../src/utils/cache.js"
import { estimateRecipe, buildNutritionPatch } from "../src/services/estimator.js"
import { getProviderChain } from "../src/services/providers/registry.js"
import { normalizeIngredients } from "../src/services/llm-normalizer.js"
import { searchOff } from "../src/services/providers/judge/off-proxy.js"
import { poolFingerprint } from "../src/services/providers/judge/candidate-pool.js"
import { JUDGE_PROMPT_VERSION } from "../src/services/providers/judge/judge.js"
import { UNKNOWN_ATTRIBUTES, type MealieRecipe, type ProviderMatch } from "../src/types.js"
import type { JudgeCandidate } from "../src/services/providers/judge/types.js"

vi.mock("../src/services/providers/registry.js", () => ({ getProviderChain: vi.fn() }))
vi.mock("../src/services/llm-normalizer.js", () => ({ normalizeIngredients: vi.fn() }))
vi.mock("../src/services/providers/judge/off-proxy.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/services/providers/judge/off-proxy.js")>(),
  searchOff: vi.fn(async () => []),
}))

const recipe: MealieRecipe = {
  slug: "audit-fixture", name: "Audit fixture", recipeYield: null, recipeServings: 1,
  nutrition: null, tags: [], extras: {},
  recipeIngredient: [{
    quantity: 100, unit: { id: "g", name: "g", pluralName: null, abbreviation: "g", standardQuantity: null, standardUnit: null },
    food: { id: "1", name: "Test grain", pluralName: null, aliases: [] },
    note: null, display: "", title: null, originalText: null,
  }],
}
const candidate: JudgeCandidate = {
  id: "usda-local:1", provider: "usda-local", providerId: "1", name: "Test grain",
  brand: null, category: null, dataType: "SR Legacy", score: 10,
  state: "unknown", form: "unknown", preservation: "unknown",
  nutrients: {
    kcalPer100g: 350, proteinPer100g: 10, carbsPer100g: 70, fatPer100g: 3,
    saturatedFatPer100g: null, transFatPer100g: null, unsaturatedFatPer100g: null,
    fiberPer100g: null, sugarPer100g: null, sodiumPer100g: null, cholesterolPer100g: null,
  },
}
let pool: JudgeCandidate[]
let deterministic: ProviderMatch | null
const originalLlm = { ...config.llm }

beforeAll(initCache)
beforeEach(() => {
  clearLlmCache()
  pool = [{ ...candidate, nutrients: { ...candidate.nutrients } }]
  vi.mocked(searchOff).mockResolvedValue([])
  deterministic = null
  Object.assign(config.llm, { enabled: true, apiKey: "test", judgeEnabled: true, nutrientEnabled: false })
  vi.mocked(normalizeIngredients).mockResolvedValue([{
    index: 0, canonicalEnglish: "test grain", canonicalGerman: "Test grain", brand: null,
    category: null, state: "unknown", foodType: "simple", coreFoodGerman: "grain", coreFoodEnglish: "grain",
    route: "generic", attributes: UNKNOWN_ATTRIBUTES, llmClassified: false,
  }])
  vi.mocked(getProviderChain).mockReturnValue([{
    name: "usda-local", lookup: async (q) => {
      if (q.poolOnly) { q.candidateSink?.(pool); return null }
      return deterministic
    },
  }])
})
afterEach(() => { vi.unstubAllGlobals(); Object.assign(config.llm, originalLlm) })

function reply(verdict: string, confidence = 0.9, id: string | null = verdict === "selected" ? candidate.id : null) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: {
    content: JSON.stringify({ decision: verdict, candidateId: id, confidence, reason: "fixture decision" }),
  } }] }), { status: 200 })))
}
async function provenance() {
  const result = await estimateRecipe(recipe)
  const patch = buildNutritionPatch(result, "hash", null)
  const rows = JSON.parse(patch.extras!.calorie_estimator_provenance) as Record<string, unknown>[]
  return { row: rows[0], result }
}
function expectAudit(row: Record<string, unknown>, verdict: string | null, reason = "fixture decision") {
  expect(row).toMatchObject({
    judgeTrigger: "gate-suppressed-pool", judgeVerdict: verdict, judgeReason: reason,
    judgeCandidates: 1, judgePoolFingerprint: poolFingerprint(pool).slice(0, 16),
    judgeModel: config.llm.judgeModel, judgePromptVersion: JUDGE_PROMPT_VERSION,
  })
}

describe("judge decisions survive final Mealie provenance serialization", () => {
  it.each(["selected", "ambiguous", "none"])("persists a %s decision with nutrient generation disabled", async (verdict) => {
    reply(verdict)
    const { row, result } = await provenance()
    expectAudit(row, verdict)
    expect(row.provider).toBe(verdict === "selected" ? "usda-local" : null)
    expect(result.matchedIngredients[0].llmParticipated).toBe(true)
    expect(result.totalNutrients.kcalPer100g).toBe(verdict === "selected" ? 350 : null)
  })

  it.each(["selected", "ambiguous", "none"])("persists the same %s audit on a cache hit", async (verdict) => {
    reply(verdict)
    const first = await provenance()
    const second = await provenance()
    expectAudit(second.row, verdict)
    expect(second.row).toEqual(first.row)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it("retains a rejected low-confidence selection without accepting its nutrients", async () => {
    reply("selected", 0.1)
    const { row, result } = await provenance()
    expectAudit(row, "selected", "below confidence floor: fixture decision")
    expect(row.provider).toBeNull()
    expect(result.matchedCount).toBe(0)
  })

  it("retains a sanity-rejected selection without accepting its nutrients", async () => {
    pool[0].nutrients.kcalPer100g = 9000
    reply("selected")
    const { row, result } = await provenance()
    expectAudit(row, "selected", String(row.judgeReason))
    expect(row.judgeReason).toMatch(/^failed nutrient sanity check:/)
    expect(row.judgeReason).toContain("fixture decision")
    expect(row.judgeCandidates).toBe(1)
    expect(row.provider).toBeNull()
    expect(result.matchedCount).toBe(0)
  })

  it("records invalid replies under the existing null-verdict convention", async () => {
    reply("selected", 1, "invented:999")
    const { row } = await provenance()
    expect(row.judgeVerdict).toBeNull()
    expect(row.judgeReason).toMatch(/not in the candidate set/)
    expect(row.judgeCandidates).toBe(1)
    expect(row.judgeModel).toBe(config.llm.judgeModel)
  })

  it("records a failed judge request without making it a semantic none", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new DOMException("Aborted", "AbortError") }))
    const { row } = await provenance()
    expectAudit(row, null, "request failed: AbortError")
    expect(row.provider).toBeNull()
  })

  it("persists an OFF-only non-selection under its actual no-database-record trigger", async () => {
    pool = []
    vi.mocked(searchOff).mockResolvedValue([{
      code: "synthetic-grain", product_name: "Test grain", brands: ["Fixture brand"],
      categories_tags: [], nutriments: { "energy-kcal_100g": 350 },
    }])
    reply("ambiguous")
    const { row } = await provenance()
    expect(row).toMatchObject({
      judgeTrigger: "no-database-record", judgeVerdict: "ambiguous", judgeReason: "fixture decision",
      judgeCandidates: 1, judgeModel: config.llm.judgeModel, judgePromptVersion: JUDGE_PROMPT_VERSION,
      provider: null,
    })
    expect(row.judgePoolFingerprint).toMatch(/^[a-f0-9]{16}$/)
  })

  it("preserves the existing accepted OFF fast path even at 0.53 confidence", async () => {
    deterministic = {
      nutrients: candidate.nutrients, provider: "off", providerId: "synthetic-grain",
      productName: "Fixture brand Test grain", canonicalName: "test grain", brand: "Fixture brand",
      state: "unknown", confidence: 0.53, matchReason: "fuzzy",
    }
    reply("ambiguous")
    const { row } = await provenance()
    expect(row).toMatchObject({ provider: "off", confidence: 0.53, matchReason: "fuzzy", judgeVerdict: null })
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each(["disabled", "empty pool", "accepted record"])("leaves decision fields null when no judge runs: %s", async (why) => {
    reply("selected")
    if (why === "disabled") config.llm.judgeEnabled = false
    if (why === "empty pool") pool = []
    if (why === "accepted record") deterministic = {
      nutrients: candidate.nutrients, provider: "usda-local", providerId: "1", productName: candidate.name,
      canonicalName: "test grain", brand: null, state: "unknown", confidence: 0.8,
    }
    const { row } = await provenance()
    expect(row.judgeTrigger).toBe(why === "accepted record" ? null : "no-database-record")
    for (const field of ["judgeVerdict", "judgeReason", "judgeCandidates", "judgePoolFingerprint", "judgeModel", "judgePromptVersion"]) {
      expect(row[field]).toBeNull()
    }
    expect(fetch).not.toHaveBeenCalled()
  })

  it("preserves judge provenance when an enabled generated fallback stands", async () => {
    config.llm.nutrientEnabled = true
    deterministic = {
      nutrients: candidate.nutrients, provider: "llm-nutrient", providerId: null, productName: null,
      canonicalName: "test grain", brand: null, state: "unknown", confidence: 0.35,
    }
    reply("none")
    const { row } = await provenance()
    expectAudit(row, "none")
    expect(row.provider).toBe("llm-nutrient")
  })

  it.each(["brand", "category", "dataType"] as const)("re-asks when candidate %s changes, but reuses an unchanged decision", async (field) => {
    reply("ambiguous")
    await provenance()
    await provenance()
    expect(fetch).toHaveBeenCalledTimes(1)
    pool[0] = { ...pool[0], [field]: "changed evidence" }
    const { row } = await provenance()
    expectAudit(row, "ambiguous")
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})
