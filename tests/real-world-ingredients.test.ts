import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { config } from "../src/config.js"
import { UNKNOWN_ATTRIBUTES } from "../src/types.js"
import { initCache, __clearProviderCachesForTests } from "../src/utils/cache.js"
import { recipe, runPipeline, type ClassificationStub } from "./helpers/e2e-pipeline.js"
import { buildResolverQuery } from "../src/services/resolver-query.js"
import { resolveNutrients } from "../src/services/nutrient-resolver.js"
import { buildNutritionPatch, estimateRecipe } from "../src/services/estimator.js"
import { lookupVocabulary } from "../src/services/vocabulary/recipe-vocabulary.js"
import { loadUsdaRecordById, usdaLocalProvider } from "../src/services/providers/usda-local-provider.js"
import { loadBlsRecordByCode } from "../src/services/providers/bls-provider.js"
import { findMismatch, cachedMatchConflict } from "../src/services/providers/ranking.js"
import { fatInDryMatter, reconcileAttributes } from "../src/services/providers/food-semantics.js"
import type { JudgeCandidate } from "../src/services/providers/judge/types.js"

beforeAll(async () => { await initCache() })
beforeEach(() => {
  config.llm.nutrientEnabled = false
  config.llm.judgeEnabled = false
  config.mealieRecipeSource.enabled = false
  __clearProviderCachesForTests()
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

const mappings: [string, string, string, string, Partial<ClassificationStub>?][] = [
  ["Koriander frisch", "fresh coriander", "usda-local", "169997"],
  ["frischer Koriander", "fresh cilantro", "usda-local", "169997"],
  ["Koriander gemahlen", "ground coriander", "usda-local", "170922"],
  ["Korianderkörner", "coriander seeds", "usda-local", "170922"],
  ["Currypulver", "curry powder", "usda-local", "170924"],
  ["Curry Gewürzmischung", "curry spice blend", "usda-local", "170924", { canonicalGerman: "Currypulver" }],
  ["Paprikapulver edelsüß", "sweet paprika powder", "usda-local", "171329"],
  ["Paprika rosenscharf", "paprika", "usda-local", "171329", { canonicalGerman: "Paprika", coreFoodGerman: "Paprika" }],
  ["Paprika edelsüß", "sweet paprika", "usda-local", "171329"],
  ["Paprikapulver rosenscharf", "hot paprika powder", "usda-local", "171329"],
  ["rote Paprika", "red bell pepper", "bls", "G543100"],
  ["Spitzpaprika rot", "red pointed pepper", "bls", "G543100"],
  ["rote Chilischoten getrocknet", "dried red chili peppers", "usda-local", "168570", { state: "dried", canonicalGerman: "getrocknete rote Chilischoten", coreFoodEnglish: "chili peppers" }],
  ["getrocknete Chilischoten", "dried chili peppers", "usda-local", "168570", { state: "dried" }],
  ["Thymian frisch", "fresh thyme", "usda-local", "173470"],
  ["getrockneter Thymian", "dried thyme", "usda-local", "170938", { state: "dried" }],
  ["Gouda 48 % Fett i. Tr.", "Gouda cheese 48% fat in dry matter", "bls", "M402600", { fatPercent: 48 }],
  ["körniger Frischkäse", "cottage cheese", "bls", "M711300", { coreFoodGerman: "Frischkäse", state: "raw" }],
  ["Gemüsebrühwürfel", "vegetable bouillon cubes", "bls", "R821000"],
  ["Basmatireis", "basmati rice", "bls", "C352000", { canonicalGerman: "Basmati-Reis", state: "raw" }],
]

for (const ai of [false, true]) {
  describe(ai ? "AI-assisted real database resolution" : "deterministic real database resolution", () => {
    it.each(mappings)("%s uses %s from %s/%s", async (name, english, provider, id, overrides) => {
      const result = await runPipeline(recipe("real-world", 1, [[100, "g", name]]), ai ? {
        classifications: [{ index: 0, canonicalGerman: name, canonicalEnglish: english, ...overrides }],
      } : {})
      expect(result.rows[0]).toMatchObject({ provider, providerId: id, llmReranked: false })
      expect(result.rows[0].matchReason).toMatch(/^recipe-vocabulary:/)
      expect(result.llmCalls.nutrients).toBe(0)
      const record = provider === "bls" ? await loadBlsRecordByCode(id) : await loadUsdaRecordById(id)
      expect(result.rows[0].productName).toBe(record!.name)
      expect(result.rows[0].kcalPer100g).toBe(record!.nutrients.kcalPer100g)
      if (name.startsWith("Gouda")) expect(result.rows[0].requestedFatPercent).toBeNull()
    })

    it.each([
      ["Koriander", "coriander"], ["Thymian", "thyme"], ["Reisessig", "rice vinegar"],
      ["Garam Masala", "garam masala"], ["Utskho Suneli", "blue fenugreek"],
      ["italienische Gewürzmischung", "Italian seasoning blend"], ["rosa Pfefferkörner", "pink peppercorns"],
      ["Erythrit", "erythritol"], ["Proteinpulver", "protein powder"],
      ["Gewürzpaste für Gemüsebrühe", "spice paste for vegetable broth"],
    ])("%s stays unresolved without adequate evidence", async (name, english) => {
      const result = await runPipeline(recipe("unresolved", 1, [[100, "g", name]]), ai ? {
        classifications: [{ index: 0, canonicalGerman: name, canonicalEnglish: english, foodType: "processed_single_food" }],
      } : {})
      expect(result.rows[0].provider).toBe("unresolved")
      expect(result.llmCalls.nutrients).toBe(0)
    })
  })
}

it("does not erase rice identity when vocabulary enrichment applies", () => {
  expect(lookupVocabulary("Reisessig")?.identity).toBe("Reisessig")
  expect(buildResolverQuery("Reisessig", undefined).query.coreFoodGerman).toBe("Reisessig")
})

it("writes real provider IDs, data type and curated selection to Mealie provenance", async () => {
  config.llm.enabled = false
  const result = await estimateRecipe(recipe("provenance", 1, [[10, "g", "Koriander frisch"]]))
  const patch = buildNutritionPatch(result, "test-hash", null)
  expect(JSON.parse(patch.extras!.calorie_estimator_provenance!)[0]).toMatchObject({
    provider: "usda-local", providerId: "169997", dataType: "SR Legacy",
    productName: "Coriander (cilantro) leaves, raw",
    classification: { vocabulary: { preferredSelected: true } },
  })
})

it.each(["Gouda 48 % Fett i. Tr.", "Gouda 48% Fett i.Tr.", "Gouda 48% F.i.T.", "Gouda 48% Fett in der Trockenmasse", "Gouda 48% fat in dry matter"])("%s is a dry-matter grade, never 48 g fat/100 g", (name) => {
  expect(fatInDryMatter(name)).toBe(48)
  expect(reconcileAttributes(name, { ...UNKNOWN_ATTRIBUTES, fatPercent: 48 }).fatPercent).toBeNull()
})
it("retains absolute milk/cream fat and rejects a contradictory cheese grade", () => {
  expect(reconcileAttributes("Kochsahne 15%", { ...UNKNOWN_ATTRIBUTES, fatPercent: 15 }).fatPercent).toBe(15)
  expect(reconcileAttributes("Gouda 48% Fett i.Tr., 31% Fett", { ...UNKNOWN_ATTRIBUTES, fatPercent: 31 }).fatPercent).toBe(31)
  expect(findMismatch("Gouda 48% Fett i.Tr.", "Gouda mind. 30 % Fett i. Tr.")).toMatch(/grade conflict/)
})
it("explicit preparation survives classifier unknowns and contradictions", () => {
  expect(reconcileAttributes("Koriander gemahlen", { ...UNKNOWN_ATTRIBUTES, form: "leaf" }).form).toBe("ground")
  expect(reconcileAttributes("rote Chilischoten getrocknet", { ...UNKNOWN_ATTRIBUTES, preservation: "fresh" }).preservation).toBe("dried")
})

it.each(["dried red chili peppers", "dried red chili pepper", "dried chile peppers", "rote Chilischoten getrocknet"])("%s cannot accept sweet peppers, including a cached match", (name) => {
  const productName = "Peppers, sweet, red, freeze-dried"
  expect(findMismatch(name, productName)).toMatch(/hot chili/)
  expect(cachedMatchConflict({ productName, foodType: "simple" }, {
    foodName: name, category: null, foodType: "simple", coreFood: null, coreMatchMode: "token",
  })).toMatch(/hot chili/)
  expect(findMismatch(name, "Peppers, hot chile, sun-dried")).toBeNull()
})
it("excludes sweet peppers from the USDA judge/rerank pool without relying on an alias", async () => {
  const pool: JudgeCandidate[] = []
  const built = buildResolverQuery("dried red chili peppers", undefined)
  await usdaLocalProvider.lookup({
    ...built.query, foodName: "dried red chili peppers", coreFoodEnglish: "chili peppers",
    state: "dried", attributes: { ...UNKNOWN_ATTRIBUTES, preservation: "dried" },
    evidence: { german: false, english: true, core: true, brand: false },
    poolOnly: true, candidateSink: (candidates) => pool.push(...candidates),
  })
  expect(pool.some((c) => c.providerId === "168570")).toBe(true)
  expect(pool.some((c) => c.providerId === "169373")).toBe(false)
})
it("a low-fat cottage cheese request is not captured by the regular default", async () => {
  config.llm.enabled = false
  const built = buildResolverQuery("körniger Frischkäse", undefined)
  const result = await resolveNutrients({ ...built.query, attributes: { ...UNKNOWN_ATTRIBUTES, fatPercent: 1.2 } }, built.route)
  expect(result?.match.providerId).not.toBe("M711300")
  expect(lookupVocabulary("körniger Frischkäse fettarm")).toBeNull()
})

it.each([
  ["Gemüsebrühe", "vegetable broth", "Brühe", "broth", "bls", "X416243"],
  ["Hoisin-Sauce", "hoisin sauce", "Sauce", "sauce", "usda-local", "172886"],
])("%s can use a generic prepared-food record with the correct food type", async (name, english, germanCore, englishCore, provider, id) => {
  const result = await runPipeline(recipe("prepared-component", 1, [[100, "g", name]]), {
    classifications: [{ index: 0, canonicalGerman: name, canonicalEnglish: english,
      coreFoodGerman: germanCore, coreFoodEnglish: englishCore, foodType: "composite_dish" }],
  })
  expect(result.rows[0]).toMatchObject({ provider, providerId: id })
  expect(result.llmCalls.nutrients).toBe(0)
})
