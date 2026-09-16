import { vi } from "vitest"
import { config } from "../../src/config.js"
import { estimateRecipe } from "../../src/services/estimator.js"
import { __clearProviderCachesForTests, clearLlmCache } from "../../src/utils/cache.js"
import type { MealieRecipe, MealieIngredient } from "../../src/types.js"

/**
 * END-TO-END harness: a raw Mealie recipe in, final provenance out, through the REAL pipeline —
 * batch normalization, attribute resolution, identity evidence, provider routing, hard gates,
 * reranking, sanity checks and recipe arithmetic.
 *
 * This exists because provider-level tests were not enough and said so loudly. Isolated tests
 * reported that canned kidney beans resolved to BLS's drained record, while production resolved
 * them to USDA's "Kidney beans, NFS" and overstated the recipe by ~196 kcal. The tests passed
 * because *I* supplied the classification they matched against — the singular core "Kidneybohne" —
 * while the real classifier returns the plural "Kidneybohnen", which the German core-identity gate
 * then rejected outright. Nothing below the normalizer can catch that class of bug.
 *
 * So the only thing stubbed here is the network: every LLM reply is a canned string, OFF and USDA
 * are recorded response shapes. Everything between the Mealie payload and the provenance is real.
 */

export interface ClassificationStub {
  index: number
  canonicalGerman: string
  canonicalEnglish: string
  brand?: string | null
  state?: string
  form?: string
  preservation?: string
  fatPercent?: number | null
  category?: string | null
  foodType?: string
  coreFoodGerman?: string
  coreFoodEnglish?: string
}

export interface E2EOptions {
  /** What the whole-recipe batch normalizer returns. Omit to run with the LLM disabled entirely. */
  classifications?: ClassificationStub[]
  /** Reply for a candidate-rerank prompt, given the candidate lines parsed out of it. */
  rerank?: (candidates: string[], prompt: string) => string
  /** Per-food nutrient fallback, keyed by the English food name the estimator asks for. */
  llmNutrients?: Record<string, Record<string, number>>
  /** Gram estimates for units the deterministic converter cannot resolve, keyed by "unit|food". */
  llmGrams?: Record<string, number>
  usda?: Record<string, unknown[]>
  off?: Record<string, unknown[]>
}

export interface E2ERow {
  ingredient: string
  provider: string
  productName: string | null
  providerId: string | null
  grams: number | null
  kcalPer100g: number | null
  kcalContribution: number
  confidence: number | null
  llmReranked: boolean
  rerankReason: string | null
  matchReason: string | null
  unmetAttributes: string[]
  requestedFatPercent: number | null
}

export interface E2EResult {
  rows: E2ERow[]
  totalKcal: number
  perServingKcal: number
  completeness: string
  matchQuality: string
  matchQualityReason: string | null
  lowConfidence: string[]
  /** How many times each kind of LLM prompt was issued — the cost side of the contract. */
  llmCalls: { normalization: number; rerank: number; nutrients: number; grams: number }
}

export function recipe(slug: string, servings: number, ingredients: [number, string | null, string][]): MealieRecipe {
  return {
    slug,
    name: slug,
    recipeYield: null,
    recipeServings: servings,
    recipeIngredient: ingredients.map(([quantity, unit, food]): MealieIngredient => ({
      quantity,
      unit: unit === null ? null : { id: unit, name: unit, pluralName: null, abbreviation: null, standardQuantity: null, standardUnit: null },
      food: { id: food, name: food, pluralName: null, aliases: [] },
      note: null,
      display: food,
      // Deliberately populated with misleading text: the pipeline must never read it.
      originalText: `${quantity} ${unit ?? ""} ${food} (IGNORE ME — stale originalText)`,
      title: null,
    })),
    nutrition: null,
    tags: [],
    extras: null,
  }
}

function classificationJson(items: ClassificationStub[]): string {
  return JSON.stringify(items.map((c) => ({
    index: c.index,
    canonicalGerman: c.canonicalGerman,
    canonicalEnglish: c.canonicalEnglish,
    brand: c.brand ?? null,
    state: c.state ?? "unknown",
    form: c.form ?? "unknown",
    preservation: c.preservation ?? "unknown",
    fatPercent: c.fatPercent ?? null,
    category: c.category ?? null,
    foodType: c.foodType ?? "simple",
    coreFoodGerman: c.coreFoodGerman ?? c.canonicalGerman,
    coreFoodEnglish: c.coreFoodEnglish ?? c.canonicalEnglish,
  })))
}

const CHAT = (content: string) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200, headers: { "content-type": "application/json" },
  })

export async function runPipeline(r: MealieRecipe, options: E2EOptions = {}): Promise<E2EResult> {
  clearLlmCache()
  __clearProviderCachesForTests()

  const calls = { normalization: 0, rerank: 0, nutrients: 0, grams: 0 }
  const llmOn = options.classifications !== undefined
  config.llm.enabled = llmOn
  config.llm.apiKey = llmOn ? "e2e-key" : ""
  config.llm.rerankEnabled = true
  config.usda.apiKey = "e2e-key"
  config.usda.retryBackoffMs = 1
  config.openFoodFacts.retryBackoffMs = 1

  vi.stubGlobal("fetch", vi.fn(async (url: unknown, init?: { body?: string }) => {
    const u = String(url)

    if (u.startsWith(config.openFoodFacts.searchBaseUrl)) {
      const q = decodeURIComponent(new URL(u).searchParams.get("q") ?? "").toLowerCase()
      return new Response(JSON.stringify({ hits: options.off?.[q] ?? [] }), { status: 200, headers: { "content-type": "application/json" } })
    }
    if (u.startsWith(config.usda.baseUrl)) {
      const q = decodeURIComponent(new URL(u).searchParams.get("query") ?? "").toLowerCase()
      return new Response(JSON.stringify({ foods: options.usda?.[q] ?? [] }), { status: 200, headers: { "content-type": "application/json" } })
    }

    // Everything else is the configured LLM endpoint; the prompt says which feature is asking.
    const prompt = String(JSON.parse(init?.body ?? "{}").messages?.[0]?.content ?? "")

    if (prompt.includes("CANDIDATES")) {
      calls.rerank++
      const candidates = prompt.split("CANDIDATES\n")[1].split("\n\nRULES")[0].split("\n")
      return CHAT(options.rerank?.(candidates, prompt) ?? '{"selected":null,"confidence":0.9,"reason":"declined by default"}')
    }
    if (prompt.startsWith("Estimate nutritional values per 100g")) {
      calls.nutrients++
      const food = Object.keys(options.llmNutrients ?? {}).find((f) => prompt.toLowerCase().includes(`"${f.toLowerCase()}"`))
      // An empty object is a well-formed "I don't know": it fails validation and the ingredient
      // stays unresolved, exactly as it would with no LLM at all.
      return CHAT(JSON.stringify(food ? options.llmNutrients![food] : {}))
    }
    if (prompt.startsWith("Estimate the weight in grams")) {
      calls.grams++
      // The real endpoint answers this one with a bare number, not JSON.
      const key = Object.keys(options.llmGrams ?? {}).find((k) => prompt.toLowerCase().includes(k.toLowerCase()))
      return CHAT(String(key ? options.llmGrams![key] : 0))
    }

    calls.normalization++
    return CHAT(classificationJson(options.classifications ?? []))
  }))

  const result = await estimateRecipe(r)

  const rows: E2ERow[] = result.matchedIngredients.map((i) => ({
    ingredient: i.name,
    provider: i.fallbackStatus,
    productName: i.productName,
    providerId: i.providerId,
    grams: i.grams,
    kcalPer100g: i.nutrients?.kcalPer100g ?? null,
    kcalContribution: i.nutrients?.kcalPer100g != null && i.grams != null ? (i.nutrients.kcalPer100g * i.grams) / 100 : 0,
    confidence: i.confidence,
    llmReranked: i.llmReranked ?? false,
    rerankReason: i.rerankReason ?? null,
    matchReason: i.matchReason ?? null,
    unmetAttributes: i.unmetAttributes ?? [],
    requestedFatPercent: i.requestedFatPercent ?? null,
  }))

  return {
    rows,
    totalKcal: result.totalNutrients.kcalPer100g ?? 0,
    perServingKcal: result.perServingNutrients.kcalPer100g ?? 0,
    completeness: result.completeness,
    matchQuality: result.matchQuality,
    matchQualityReason: result.matchQualityReason,
    lowConfidence: result.lowConfidenceIngredients,
    llmCalls: calls,
  }
}

export function row(result: E2EResult, ingredient: string): E2ERow {
  const found = result.rows.find((r) => r.ingredient === ingredient)
  if (!found) throw new Error(`no provenance row for "${ingredient}" (have: ${result.rows.map((r) => r.ingredient).join(", ")})`)
  return found
}

export function formatRows(result: E2EResult): string {
  return result.rows.map((r) =>
    `${r.ingredient.slice(0, 26).padEnd(28)}${String(r.grams ?? "—").padStart(7)}g  ${r.provider.padEnd(13)}` +
    `${(r.productName ?? "—").slice(0, 40).padEnd(42)}${String(r.kcalPer100g ?? "—").padStart(7)}` +
    `${r.kcalContribution.toFixed(0).padStart(8)}${String(r.confidence ?? "—").padStart(7)}${r.llmReranked ? "  reranked" : ""}`).join("\n")
}
