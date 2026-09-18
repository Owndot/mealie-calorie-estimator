import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest"
import { config } from "../src/config.js"
import { initCache, clearLlmCache, __clearProviderCachesForTests } from "../src/utils/cache.js"
import { resolveNutrients } from "../src/services/nutrient-resolver.js"
import { buildResolverQuery } from "../src/services/resolver-query.js"
import { sanityCheckNutrients } from "../src/services/sanity-check.js"
import { UNKNOWN_ATTRIBUTES, type FoodAttributes, type NutrientSet } from "../src/types.js"

/**
 * THE v1.3.2 PRODUCTION CORPUS: 243 ingredient rows, 233 matched, 10 unresolved (95.9 %).
 *
 * Most of those ten are the resolver working. A generic `Koriander` really can mean leaf or seed;
 * a generic `Proteinpulver` really can be whey, casein, soy or pea. Guessing would be a large
 * silent error, and unresolved is recoverable. So this file pins the DECISIONS, not a match rate:
 * the safe refusals must keep refusing, and the two genuine bugs behind them must stay fixed.
 *
 * Every case runs with `LLM_NUTRIENT_ENABLED=false`, as production does.
 */

const JUDGE_MARKER = "SEMANTIC JUDGE"
const attrs = (o: Partial<FoodAttributes> = {}): FoodAttributes => ({ ...UNKNOWN_ATTRIBUTES, ...o })

const N = (o: Partial<NutrientSet>): NutrientSet => ({
  kcalPer100g: null, proteinPer100g: 0, carbsPer100g: 0, fatPer100g: 0,
  saturatedFatPer100g: null, transFatPer100g: null, unsaturatedFatPer100g: null,
  fiberPer100g: null, sugarPer100g: null, sodiumPer100g: null, cholesterolPer100g: null, ...o,
})

interface Q { de: string; en: string; coreDe: string | null; coreEn: string | null; category?: string | null; state?: string; foodType?: string; attributes?: FoodAttributes }

const resolve = (q: Q) => resolveNutrients({
  foodName: q.en, structuredName: q.de, canonicalGerman: q.de, brand: null,
  category: q.category ?? null, state: q.state ?? "unknown", foodType: q.foodType ?? "simple",
  coreFoodGerman: q.coreDe, coreFoodEnglish: q.coreEn, route: "generic",
  attributes: q.attributes ?? attrs(),
  evidence: { german: true, english: true, core: true, brand: false },
} as never, "generic")

let calls: { judge: number; nutrients: number; offSearches: number }
let offered: string[] = []

function stub(hits: unknown[], judgeReply: (ids: string[]) => string) {
  calls = { judge: 0, nutrients: 0, offSearches: 0 }
  offered = []
  const chat = (content: string) =>
    new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200, headers: { "content-type": "application/json" },
    })
  vi.stubGlobal("fetch", vi.fn(async (url: unknown, init?: { body?: string }) => {
    if (String(url).startsWith(config.openFoodFacts.searchBaseUrl)) {
      calls.offSearches++
      return new Response(JSON.stringify({ hits }), { status: 200, headers: { "content-type": "application/json" } })
    }
    const body = JSON.parse(String(init?.body ?? "{}"))
    if (String(body.messages?.[0]?.content ?? "").includes(JUDGE_MARKER)) {
      calls.judge++
      const user = String(body.messages?.[1]?.content ?? "")
      offered = [...user.matchAll(/id=(\S+) \|/g)].map((m) => m[1])
      return chat(judgeReply(offered))
    }
    calls.nutrients++
    return chat(JSON.stringify({ kcal: 999, protein: 9, carbs: 9, fat: 9 }))
  }))
}

const DECLINE = () => '{"decision":"none","candidateId":null,"confidence":1,"reason":"no safe match"}'
const AMBIGUOUS = () => '{"decision":"ambiguous","candidateId":null,"confidence":1,"reason":"several equally plausible"}'
const pickOff = (ids: string[]) => {
  const t = ids.find((i) => i.startsWith("off:"))
  return t ? `{"decision":"selected","candidateId":"${t}","confidence":0.9,"reason":"same product"}` : DECLINE()
}

const product = (over: Record<string, unknown> = {}) => ({
  code: "0000", product_name: "X", brands: ["B"],
  categories_tags: ["en:groceries"],
  nutriments: { "energy-kcal_100g": 100, proteins_100g: 1, carbohydrates_100g: 10, fat_100g: 1 },
  ...over,
})

beforeAll(async () => { await initCache() })

beforeEach(() => {
  clearLlmCache()
  __clearProviderCachesForTests()
  config.llm.enabled = true
  config.llm.apiKey = "test-key"
  config.llm.judgeEnabled = true
  config.llm.rerankEnabled = false
  config.llm.nutrientEnabled = false
  config.openFoodFacts.retryBackoffMs = 1
})

afterEach(() => {
  config.llm.enabled = false
  config.llm.apiKey = ""
  config.llm.judgeEnabled = false
  config.llm.nutrientEnabled = true
  vi.restoreAllMocks()
})

/* ─────────────────────────── 1. the erythritol sanity-check bug ─────────────────────────── */

describe("sugar alcohols are not 4 kcal/g", () => {
  /**
   * Production: the judge correctly selected a real `Erythrit` record and the generic macro-energy
   * check threw it away — 100 g of carbohydrate "should" be ~400 kcal, and erythritol is 0.
   * EU 1169/2011 rates polyols at 2.4 kcal/g and erythritol explicitly at 0, so where polyols are
   * present the expectation is a RANGE across those two factors rather than a single number.
   */
  it("the exact production case is accepted", () => {
    const r = sanityCheckNutrients(N({ kcalPer100g: 0, carbsPer100g: 100 }), "erythritol")
    expect(r.ok, r.reason ?? "").toBe(true)
  })

  it("uses the provider's own polyol figure when there is one, not the name", () => {
    // OFF reports `polyols_100g`. A product that does not say "erythritol" anywhere still gets the
    // right expectation, which is the point of carrying the field rather than matching names.
    const r = sanityCheckNutrients(
      N({ kcalPer100g: 20, carbsPer100g: 95, polyolsPer100g: 95 }), "Streusüße Backmischung")
    expect(r.ok, r.reason ?? "").toBe(true)
  })

  it.each([
    ["Erythrit", 0], ["Xylit", 240], ["Sorbitol", 240], ["Maltitol", 210],
    ["Mannitol", 160], ["Isomalt", 240], ["Lactitol", 240],
  ])("%s at %i kcal/100 g is accepted", (name, kcal) => {
    const r = sanityCheckNutrients(N({ kcalPer100g: kcal, carbsPer100g: 100 }), name)
    expect(r.ok, r.reason ?? "").toBe(true)
  })

  it.each([
    ["Stevia"], ["Sucralose"], ["Aspartam"], ["Süßstoff"],
    // Isomaltulose is a genuine 4 kcal/g sugar whose name merely starts like a polyol.
    ["Isomaltulose"],
  ])("%s is NOT treated as a polyol — the exception stays narrow", (name) => {
    const r = sanityCheckNutrients(N({ kcalPer100g: 0, carbsPer100g: 100 }), name)
    expect(r.ok).toBe(false)
  })

  it("the check stays meaningful for polyols themselves", () => {
    // Widening by the polyol grams is not the same as switching the check off.
    expect(sanityCheckNutrients(N({ kcalPer100g: 900, carbsPer100g: 100 }), "Erythrit").ok).toBe(false)
    expect(sanityCheckNutrients(N({ kcalPer100g: -5, carbsPer100g: 100 }), "Xylit").ok).toBe(false)
  })

  it.each([
    ["sugar that claims to be calorie-free", N({ kcalPer100g: 0, carbsPer100g: 100 }), "Zucker"],
    ["energy from nowhere", N({ kcalPer100g: 800 }), "Wasser"],
    ["sugar exceeding total carbs", N({ kcalPer100g: 400, carbsPer100g: 10, sugarPer100g: 50 }), "Marmelade"],
  ])("ordinary foods with impossible numbers are still rejected: %s", (_l, n, food) => {
    expect(sanityCheckNutrients(n, food).ok).toBe(false)
  })

  it.each([
    ["Rotwein", N({ kcalPer100g: 85, carbsPer100g: 2.6 })],
    ["Whisky", N({ kcalPer100g: 250 })],
    ["Weißbier", N({ kcalPer100g: 45, carbsPer100g: 3 })],
  ])("the existing alcohol exception still holds for %s", (food, n) => {
    expect(sanityCheckNutrients(n, food).ok, food).toBe(true)
  })

  it("a food with no polyols keeps exactly today's arithmetic", () => {
    // 4/4/9 with the existing tolerance: 250 against an expected 255 is fine, 600 is not.
    const macros = { proteinPer100g: 20, carbsPer100g: 10, fatPer100g: 15 }
    expect(sanityCheckNutrients(N({ ...macros, kcalPer100g: 250 }), "Rinderhack").ok).toBe(true)
    expect(sanityCheckNutrients(N({ ...macros, kcalPer100g: 600 }), "Rinderhack").ok).toBe(false)
  })
})

/* ─────────────────────────── 2. OFF observability ─────────────────────────── */

describe("the log says which OFF route actually ran", () => {
  /**
   * `offQueried` was wired to the PROXY decision alone, so a real last-resort search — a live
   * network call — was logged as `offQueried: false`. Any audit asking "was OFF even consulted?"
   * got the wrong answer for exactly the ingredients this release is about.
   */
  const captured: Record<string, unknown>[] = []
  beforeEach(async () => {
    captured.length = 0
    const { logger } = await import("../src/utils/logger.js")
    vi.spyOn(logger, "info").mockImplementation(((o: unknown) => {
      if (o && typeof o === "object") captured.push(o as Record<string, unknown>)
    }) as never)
  })
  const judgeLog = () => captured.find((o) => "offQueried" in o)

  it("last-resort route reports offQueried=true and offRoute='last-resort'", async () => {
    stub([product({ code: "1", product_name: "Hoisin Sauce" })], DECLINE)
    await resolve({ de: "Hoisin-Sauce", en: "hoisin sauce", coreDe: "Sauce", coreEn: "sauce" })
    expect(judgeLog()?.offQueried).toBe(true)
    expect(judgeLog()?.offRoute).toBe("last-resort")
  })

  it("proxy route reports offQueried=true and offRoute='proxy'", async () => {
    stub([product({
      code: "2", product_name: "Kochsahne 7%", categories_tags: ["en:dairies", "en:creams"],
      nutriments: { "energy-kcal_100g": 85, proteins_100g: 2.9, carbohydrates_100g: 3.9, fat_100g: 7 },
    })], DECLINE)
    await resolve({
      de: "Kochsahne 7 % Fett", en: "cooking cream 7% fat", coreDe: "Sahne", coreEn: "cream",
      category: "dairy", foodType: "processed_single_food", attributes: attrs({ fatPercent: 7 }),
    })
    expect(judgeLog()?.offQueried).toBe(true)
    expect(judgeLog()?.offRoute).toBe("proxy")
  })

  it("no OFF route reports offQueried=false and offRoute=null", async () => {
    // A stated number a local record already carries: OFF adds a round trip and nothing else.
    stub([product()], DECLINE)
    await resolve({
      de: "Rinderhackfleisch 10 % Fett", en: "ground beef 10% fat", coreDe: "Rinderhackfleisch",
      coreEn: "ground beef", category: "meat", state: "raw", attributes: attrs({ fatPercent: 10 }),
    })
    const log = judgeLog()
    if (log) {
      expect(log.offQueried).toBe(false)
      expect(log.offRoute).toBeNull()
    }
  })
})

/* ─────────────────────── 3. the ten production unresolved rows ─────────────────────── */

describe("generic words that genuinely have two meanings stay unresolved", () => {
  it("bare Koriander resolves to neither leaf nor seed", async () => {
    // Leaf is 23 kcal/100 g and seed is 298. Nothing in the word chooses, so nothing may.
    stub([], DECLINE)
    const r = await resolve({ de: "Koriander", en: "coriander", coreDe: "Koriander", coreEn: "coriander", category: "herb" })
    expect(r).toBeNull()
    expect(calls.nutrients).toBe(0)
  })

  it("explicit fresh coriander still resolves to USDA 169997", async () => {
    // The verified v1.3.2 success this must not cost us. Built through buildResolverQuery, because
    // that is where the curated vocabulary is consulted — the path production actually takes.
    stub([], DECLINE)
    const built = buildResolverQuery("Koriander frisch", {
      index: 0, canonicalGerman: "Koriander frisch", canonicalEnglish: "fresh coriander",
      coreFoodGerman: "Koriander", coreFoodEnglish: "coriander", brand: null, category: "herb",
      state: "unknown", attributes: attrs({ form: "leaf", preservation: "fresh" }),
      foodType: "simple", route: "generic", llmClassified: true,
    } as never, {})
    const r = await resolveNutrients(built.query, built.route)
    expect(r?.match.providerId).toBe("169997")
    expect(r?.match.matchReason).toMatch(/^recipe-vocabulary:/)
  })

  it("generic Proteinpulver does not pick a protein source", async () => {
    // Whey, casein, soy and pea differ materially. "Ambiguous" is the correct verdict.
    stub([product({ code: "w", product_name: "Whey Protein" }), product({ code: "p", product_name: "Erbsenprotein" })], AMBIGUOUS)
    const r = await resolve({ de: "Proteinpulver", en: "protein powder", coreDe: "Proteinpulver", coreEn: "protein powder", attributes: attrs({ form: "powder" }) })
    expect(r).toBeNull()
  })

  it("italienische Gewürzmischung does not pick a brand", async () => {
    stub([product({ code: "a", product_name: "Italienische Kräuter" }), product({ code: "b", product_name: "Italian Seasoning" })], AMBIGUOUS)
    const r = await resolve({ de: "italienische Gewürzmischung", en: "Italian seasoning", coreDe: "Gewürzmischung", coreEn: "seasoning" })
    expect(r).toBeNull()
  })

  it.each([
    ["Hoisin-Sauce", "hoisin sauce", "Sauce", "sauce"],
    ["Reisessig", "rice vinegar", "Essig", "vinegar"],
  ])("%s stays unresolved while several equivalent brands compete", async (de, en, coreDe, coreEn) => {
    stub([
      product({ code: "1", product_name: en, brands: ["Brand A"] }),
      product({ code: "2", product_name: en, brands: ["Brand B"] }),
      product({ code: "3", product_name: en, brands: ["Brand C"] }),
    ], AMBIGUOUS)
    const r = await resolve({ de, en, coreDe, coreEn })
    expect(r, "an arbitrary brand is not an answer").toBeNull()
  })
})

describe("wrong-category candidates stay rejected", () => {
  it("pink peppercorns never become pork", async () => {
    // Production offered exactly one candidate and the judge said "Candidate is pork, not pink
    // peppercorns." Whatever else changes, that must keep being refused.
    stub([], () => '{"decision":"none","candidateId":null,"confidence":1,"reason":"Candidate is pork, not pink peppercorns."}')
    const r = await resolve({ de: "rosa Pfefferkörner", en: "pink peppercorns", coreDe: "Pfefferkorn", coreEn: "peppercorn", category: "spice" })
    expect(r?.match.productName ?? "").not.toMatch(/pork|schwein/i)
    expect(r).toBeNull()
  })

  it("Utskho Suneli is offered to the judge but not forced onto fenugreek", async () => {
    stub([product({ code: "f", product_name: "Bockshornklee gemahlen" })], DECLINE)
    const r = await resolve({ de: "Utskho Suneli", en: "Utskho Suneli", coreDe: "Gewürzmischung", coreEn: "spice blend" })
    expect(r).toBeNull()
    expect(calls.nutrients).toBe(0)
  })
})

describe("an exact product label outranks its own variants", () => {
  /**
   * `Leerdammer Leger` came back `ambiguous` against twelve Leerdammer records — the classifier
   * had translated `Léger` to `Light`, so the English name matched no label. One candidate's whole
   * label equals the whole ingredient text; the rest are variants of it, and they are withdrawn so
   * the judge is asked a question that has an answer. The judge still decides.
   */
  const variants = [
    product({ code: "4388860276916", product_name: "Leerdammer Leger", brands: ["Leerdammer"], categories_tags: ["en:dairies", "en:cheeses"], nutriments: { "energy-kcal_100g": 262, proteins_100g: 27, carbohydrates_100g: 0.1, fat_100g: 17 } }),
    product({ code: "111", product_name: "Leerdammer Original", brands: ["Leerdammer"], categories_tags: ["en:cheeses"], nutriments: { "energy-kcal_100g": 351, proteins_100g: 27, carbohydrates_100g: 0, fat_100g: 27 } }),
    product({ code: "222", product_name: "Leerdammer Caractere", brands: ["Leerdammer"], categories_tags: ["en:cheeses"], nutriments: { "energy-kcal_100g": 361, proteins_100g: 26, carbohydrates_100g: 0, fat_100g: 29 } }),
  ]

  it("the exact label wins and carries the real barcode", async () => {
    stub(variants, pickOff)
    const r = await resolve({ de: "Leerdammer Leger", en: "Leerdammer Light", coreDe: "Käse", coreEn: "cheese", category: "dairy" })
    expect(offered.filter((i) => i.startsWith("off:")), "the variants are withdrawn").toHaveLength(1)
    expect(r?.fallbackStatus).toBe("off")
    expect(r?.match.providerId).toBe("4388860276916")
    expect(r?.match.nutrients.kcalPer100g).toBe(262)
    expect(calls.nutrients).toBe(0)
  })

  it("the judge can still decline the exact label", async () => {
    stub(variants, DECLINE)
    const r = await resolve({ de: "Leerdammer Leger", en: "Leerdammer Light", coreDe: "Käse", coreEn: "cheese", category: "dairy" })
    expect(r).toBeNull()
  })

  it("a generic food whose label many brands share is NOT narrowed", async () => {
    // Three products all called "Hoisin Sauce": equality is not unique, so nothing is withdrawn
    // and the ambiguity is real. This is what keeps the rule about products, not foods.
    stub([
      product({ code: "1", product_name: "Hoisin Sauce", brands: ["A"] }),
      product({ code: "2", product_name: "Hoisin Sauce", brands: ["B"] }),
      product({ code: "3", product_name: "Hoisin Sauce", brands: ["C"] }),
    ], AMBIGUOUS)
    const r = await resolve({ de: "Hoisin-Sauce", en: "hoisin sauce", coreDe: "Sauce", coreEn: "sauce" })
    // Three products carry the same label, so the exact-label rule finds no unique winner, nothing
    // is withdrawn, and the judge's "ambiguous" stands. A shared label is not an identity.
    expect(r, "an arbitrary brand is not an answer").toBeNull()
  })
})
