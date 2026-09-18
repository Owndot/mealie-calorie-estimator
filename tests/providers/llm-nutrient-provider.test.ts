import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest"
import { llmNutrientProvider } from "../../src/services/providers/llm-nutrient-provider.js"
import { initCache, clearLlmCache } from "../../src/utils/cache.js"
import { config } from "../../src/config.js"
import { providerQuery } from "../helpers/provider-query.js"

beforeAll(async () => {
  await initCache()
})

beforeEach(() => {
  config.llm.enabled = false
  config.llm.apiKey = ""
  clearLlmCache()
  vi.restoreAllMocks()
})

function query(foodName: string) {
  return providerQuery({ foodName })
}

describe("LlmNutrientProvider — final fallback only", () => {
  it("returns null when the LLM is disabled", async () => {
    const match = await llmNutrientProvider.lookup(query("Mystery Food"))
    expect(match).toBeNull()
  })

  it("returns a low-confidence match (never a brand) when the LLM resolves the food", async () => {
    config.llm.enabled = true
    config.llm.apiKey = "sk-test"

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({ kcal: 200, protein: 5, carbs: 20, fat: 8, saturatedFat: 2, transFat: 0, fiber: 1, sugar: 3, sodium: 0.2, cholesterol: 0.02 }) } }],
      }),
    })
    vi.stubGlobal("fetch", mockFetch)

    const match = await llmNutrientProvider.lookup(query("Obscure LLM Food"))
    expect(match?.provider).toBe("llm-nutrient")
    expect(match?.brand).toBeNull()
    expect(match?.confidence).toBeLessThan(0.5) // marked clearly lower-confidence than database matches
  })
})
