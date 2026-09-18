import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from "vitest"
import { config } from "../src/config.js"
import { UNKNOWN_ATTRIBUTES } from "../src/types.js"
import { initCache, clearLlmCache } from "../src/utils/cache.js"
import { estimateGrams } from "../src/services/llm-estimator.js"
import { normalizeIngredients } from "../src/services/llm-normalizer.js"
import { rerankCandidates } from "../src/services/providers/candidate-rerank.js"
import { getProviderChain } from "../src/services/providers/registry.js"

/**
 * LLM_NUTRIENT_ENABLED — the switch for direct nutrient GENERATION alone.
 *
 * Every other LLM capability ends on a record some database publishes: classification and
 * translation pick the words a lookup is made with, gram estimation answers "how much is a Dose",
 * and the reranker and judge choose between records retrieval already found. Only llm-nutrient
 * invents the numbers themselves, at confidence 0.35 with providerId and productName null.
 *
 * That difference is about coverage, not just provenance. A generated value makes an ingredient
 * count as RESOLVED, so an ingredient nothing could match becomes a `complete` recipe whose
 * calories are partly invented. This flag lets a deployment see the gap instead, without giving up
 * the model's help anywhere else.
 *
 * The flag defaults TRUE, so LLM_ENABLED on its own behaves exactly as it did before it existed.
 */

/** Re-imports config.ts under a patched environment, to exercise the env parsing itself. */
async function configWithEnv(env: Record<string, string | undefined>) {
  const saved = { ...process.env }
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  vi.resetModules()
  try {
    return (await import("../src/config.js")).config
  } finally {
    process.env = saved
    vi.resetModules()
  }
}

const chainNames = (route: "generic" | "branded" = "generic") => getProviderChain(route).map((p) => p.name)

beforeAll(async () => { await initCache() })

beforeEach(() => {
  config.llm.enabled = true
  config.llm.apiKey = "test-key"
  config.llm.nutrientEnabled = true
  clearLlmCache()
  vi.restoreAllMocks()
})

afterEach(() => {
  config.llm.enabled = false
  config.llm.apiKey = ""
  config.llm.nutrientEnabled = true
  vi.restoreAllMocks()
})

describe("A. the flag defaults to true, so existing deployments are unaffected", () => {
  it("is true when LLM_NUTRIENT_ENABLED is unset", async () => {
    const c = await configWithEnv({ LLM_NUTRIENT_ENABLED: undefined })
    expect(c.llm.nutrientEnabled).toBe(true)
  })

  it.each([["true", true], ["TRUE", true], ["false", false], ["FALSE", false]])(
    "parses %j as %s", async (value, expected) => {
      const c = await configWithEnv({ LLM_NUTRIENT_ENABLED: value })
      expect(c.llm.nutrientEnabled).toBe(expected)
    })

  it("follows the same parsing convention as every other LLM flag", async () => {
    // `(env || default).toLowerCase() === "true"` — shared verbatim with LLM_ENABLED,
    // LLM_RERANK_ENABLED and LLM_JUDGE_ENABLED. Only the DEFAULT differs.
    //
    // A consequence worth stating: because the default is true, anything that is not the literal
    // "true" turns the tier OFF, so a typo silently disables generation rather than silently
    // enabling it. That is the safe direction of the two, and consistency with the other flags
    // is worth more here than a bespoke parser.
    expect((await configWithEnv({ LLM_NUTRIENT_ENABLED: "no" })).llm.nutrientEnabled).toBe(false)
    expect((await configWithEnv({ LLM_NUTRIENT_ENABLED: "" })).llm.nutrientEnabled).toBe(true)
  })
})

describe("B/C. the flag decides whether the generation tier is registered at all", () => {
  it("registers llm-nutrient last on both routes when enabled", () => {
    expect(chainNames("generic").at(-1)).toBe("llm-nutrient")
    expect(chainNames("branded").at(-1)).toBe("llm-nutrient")
  })

  it("omits llm-nutrient on both routes when disabled", () => {
    config.llm.nutrientEnabled = false
    expect(chainNames("generic")).not.toContain("llm-nutrient")
    expect(chainNames("branded")).not.toContain("llm-nutrient")
  })

  it("leaves every database provider in place and in order when disabled", () => {
    // The point of the flag is to remove ONE tier. Nothing else about the chain may move.
    const before = chainNames()
    config.llm.nutrientEnabled = false
    expect(chainNames()).toEqual(before.filter((n) => n !== "llm-nutrient"))
    expect(chainNames()).toEqual(["mealie-recipe", "food-override", "bls", "usda-local", "off"])
  })

  it.each([
    ["LLM_ENABLED false", { enabled: false, apiKey: "test-key", nutrientEnabled: true }],
    ["no API key", { enabled: true, apiKey: "", nutrientEnabled: true }],
    ["nutrient generation off", { enabled: true, apiKey: "test-key", nutrientEnabled: false }],
  ])("still requires all three: %s omits the tier", (_label, over) => {
    Object.assign(config.llm, over)
    expect(chainNames()).not.toContain("llm-nutrient")
  })
})

describe("D. an ingredient nothing can resolve stays unresolved rather than being invented", () => {
  /** Builds a chain where every database provider misses, with llm-nutrient mocked but real-shaped. */
  async function resolveWithEverythingMissing(nutrientEnabled: boolean) {
    vi.resetModules()
    const llmLookup = vi.fn().mockResolvedValue({
      nutrients: {
        kcalPer100g: 250, proteinPer100g: 5, carbsPer100g: 30, fatPer100g: 10,
        saturatedFatPer100g: 2, transFatPer100g: null, unsaturatedFatPer100g: 6,
        fiberPer100g: 2, sugarPer100g: 4, sodiumPer100g: 0.2, cholesterolPer100g: 0,
      },
      canonicalName: "invented", brand: null, state: "unknown" as const,
      provider: "llm-nutrient", providerId: null, productName: null, confidence: 0.35,
    })
    const miss = () => vi.fn().mockResolvedValue(null)
    vi.doMock("../src/services/providers/bls-provider.js", () => ({
      createBlsProviderIfAvailable: () => ({ name: "bls", lookup: miss() }),
      loadBlsRecordByCode: vi.fn().mockResolvedValue(null),
    }))
    vi.doMock("../src/services/providers/usda-local-provider.js", () => ({
      usdaLocalProvider: { name: "usda-local", lookup: miss() },
      loadUsdaRecordById: vi.fn().mockResolvedValue(null),
    }))
    vi.doMock("../src/services/providers/off-provider.js", () => ({ offProvider: { name: "off", lookup: miss() } }))
    vi.doMock("../src/services/providers/mealie-recipe-provider.js", () => ({ mealieRecipeProvider: { name: "mealie-recipe", lookup: miss() } }))
    vi.doMock("../src/services/providers/override-provider.js", () => ({ overrideProvider: { name: "food-override", lookup: miss() } }))
    vi.doMock("../src/services/providers/llm-nutrient-provider.js", () => ({
      llmNutrientProvider: { name: "llm-nutrient", lookup: llmLookup },
    }))
    const { config: c } = await import("../src/config.js")
    c.llm.enabled = true
    c.llm.apiKey = "test-key"
    c.llm.nutrientEnabled = nutrientEnabled
    const { resolveNutrients } = await import("../src/services/nutrient-resolver.js")
    const { providerQuery } = await import("./helpers/provider-query.js")
    const result = await resolveNutrients(providerQuery({ foodName: "Utskho Suneli" }), "generic")
    vi.resetModules()
    return { result, llmLookup }
  }

  it("generates a value when nutrient generation is enabled", async () => {
    const { result, llmLookup } = await resolveWithEverythingMissing(true)
    expect(llmLookup).toHaveBeenCalled()
    expect(result?.fallbackStatus).toBe("llm-nutrient")
    expect(result?.match.nutrients.kcalPer100g).toBe(250)
  })

  it("returns nothing, and never calls the generator, when it is disabled", async () => {
    const { result, llmLookup } = await resolveWithEverythingMissing(false)
    expect(result, "an unresolvable ingredient must stay unresolved").toBeNull()
    expect(llmLookup, "the generator must not even be consulted").not.toHaveBeenCalled()
  })
})

describe("E/F/G. every other LLM capability is untouched while generation is off", () => {
  beforeEach(() => { config.llm.nutrientEnabled = false })

  it("E. classification and translation still run", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify([{
        index: 0, canonicalGerman: "Zwiebel", canonicalEnglish: "onion", coreFoodGerman: "Zwiebel",
        coreFoodEnglish: "onion", brand: null, category: "vegetable", state: "raw",
        foodType: "simple", route: "generic",
      }]) } }] }),
    })
    vi.stubGlobal("fetch", fetchMock)

    const [out] = await normalizeIngredients([{ index: 0, foodName: "Zwiebel", unitName: "Stück" }])
    expect(fetchMock, "the classifier must still be called").toHaveBeenCalled()
    expect(out?.canonicalEnglish).toBe("onion")
    expect(out?.llmClassified).toBe(true)
  })

  it("F. gram estimation still runs", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ choices: [{ message: { content: "400" } }] }),
    })
    vi.stubGlobal("fetch", fetchMock)

    expect(await estimateGrams(2, "Dose", "Tomaten")).toBe(800)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("G. candidate reranking still runs", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ selection: 1, confidence: 0.9, reason: "same food" }) } }] }),
    })
    vi.stubGlobal("fetch", fetchMock)

    const decision = await rerankCandidates(
      { provider: "bls", structuredName: "Zwiebel", canonicalEnglish: "onion", state: "raw", attributes: UNKNOWN_ATTRIBUTES },
      [
        { providerId: "G480100", productName: "Speisezwiebel roh", kcalPer100g: 28, form: "unknown", preservation: "unknown", score: 70 },
        { providerId: "G480200", productName: "Lauchzwiebel roh", kcalPer100g: 27, form: "unknown", preservation: "unknown", score: 60 },
      ],
    )
    expect(fetchMock, "the reranker must still be called").toHaveBeenCalled()
    expect(decision?.confidence).toBe(0.9)
  })

  it("G. the judge switch is independent and untouched", async () => {
    // judgeEnabled has never depended on the generation tier, and must not start to.
    const c = await configWithEnv({ LLM_NUTRIENT_ENABLED: "false", LLM_JUDGE_ENABLED: "true", LLM_RERANK_ENABLED: "true" })
    expect(c.llm.nutrientEnabled).toBe(false)
    expect(c.llm.judgeEnabled).toBe(true)
    expect(c.llm.rerankEnabled).toBe(true)
  })
})
