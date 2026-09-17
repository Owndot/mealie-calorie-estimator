import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest"
import { config } from "../src/config.js"
import { initCache, clearLlmCache, __clearProviderCachesForTests } from "../src/utils/cache.js"
import { resolveNutrients } from "../src/services/nutrient-resolver.js"
import { useUsdaLocalFixture, resetUsdaLocalFixture } from "./helpers/usda-local-fixture.js"
import { UNKNOWN_ATTRIBUTES, type FoodAttributes } from "../src/types.js"

/**
 * PR C — the semantic judge, enabled for the two strictly ADDITIVE triggers only.
 *
 * The judge is asked exactly when there is nothing to protect: the deterministic chain has run and
 * its answer is a fabricated estimate or nothing at all, while real records DID survive every hard
 * semantic gate and were discarded only on SCORE. That is the population the old
 * RERANK_MIN_CANDIDATE_SCORE floor hid — measured on the bundled corpus, eight of nine
 * gate-surviving black-bean records sat below it, both canned ones among them.
 *
 * Everything here is about one property: this change can turn a fabricated number into a real
 * record, and it cannot make any currently-accepted result worse.
 */

const JUDGE_MARKER = "SEMANTIC JUDGE"

interface Stubs {
  /** Reply for the judge prompt, given the candidate ids it was offered. */
  judge?: (ids: string[], prompt: string) => string | Response | Promise<Response>
  /** Per-100 g fallback the llm-nutrient provider returns. */
  nutrients?: Record<string, number>
}

let calls: { judge: number; nutrients: number }

function stub(s: Stubs = {}) {
  calls = { judge: 0, nutrients: 0 }
  const chat = (content: string) =>
    new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200, headers: { "content-type": "application/json" },
    })

  vi.stubGlobal("fetch", vi.fn(async (url: unknown, init?: { body?: string }) => {
    const u = String(url)
    if (u.startsWith(config.openFoodFacts.searchBaseUrl)) {
      return new Response(JSON.stringify({ hits: [] }), { status: 200, headers: { "content-type": "application/json" } })
    }
    const body = String(init?.body ?? "{}")
    const prompt = String(JSON.parse(body).messages?.[0]?.content ?? "")
    const userPrompt = String(JSON.parse(body).messages?.[1]?.content ?? "")

    if (prompt.includes(JUDGE_MARKER)) {
      calls.judge++
      const ids = [...userPrompt.matchAll(/id=(\S+) \|/g)].map((m) => m[1])
      const reply = s.judge?.(ids, userPrompt) ?? '{"decision":"none","candidateId":null,"confidence":1,"reason":"no candidate"}'
      return typeof reply === "string" ? chat(reply) : reply
    }
    calls.nutrients++
    return chat(JSON.stringify(s.nutrients ?? { kcal: 110, protein: 4, carbs: 20, fat: 1.6 }))
  }))
}

const attrs = (o: Partial<FoodAttributes> = {}): FoodAttributes => ({ ...UNKNOWN_ATTRIBUTES, ...o })

interface Q { de: string; en: string; coreDe: string | null; coreEn: string | null; category?: string | null; state?: string; foodType?: string; attributes?: FoodAttributes }

const resolve = (q: Q) => resolveNutrients({
  foodName: q.en, structuredName: q.de, canonicalGerman: q.de, brand: null,
  category: q.category ?? null, state: q.state ?? "unknown", foodType: q.foodType ?? "simple",
  coreFoodGerman: q.coreDe, coreFoodEnglish: q.coreEn, route: "generic",
  attributes: q.attributes ?? attrs(),
  evidence: { german: true, english: true, core: true, brand: false },
} as never, "generic")

beforeAll(async () => { await initCache() })

beforeEach(() => {
  clearLlmCache()
  __clearProviderCachesForTests()
  config.llm.enabled = true
  config.llm.apiKey = "test-key"
  config.llm.judgeEnabled = true
  config.llm.rerankEnabled = false
  config.openFoodFacts.retryBackoffMs = 1
})
afterEach(() => {
  vi.unstubAllGlobals()
  resetUsdaLocalFixture()
  config.llm.judgeEnabled = false
  config.llm.rerankEnabled = true
  config.llm.enabled = false
  config.llm.apiKey = ""
})

// ---------------------------------------------------------------------------------------------

describe("a good deterministic result is never put to the judge", () => {
  const FAST_PATH: [string, Q, string, string][] = [
    ["Olivenöl", { de: "Olivenöl", en: "olive oil", coreDe: "Öl", coreEn: "oil", category: "oil" }, "bls", "Olivenöl"],
    ["Tomate", { de: "Tomate", en: "tomato", coreDe: "Tomate", coreEn: "tomato", category: "vegetable", state: "raw" }, "bls", "Tomate roh"],
    ["Tomatenmark", { de: "Tomatenmark", en: "tomato paste", coreDe: "Tomatenmark", coreEn: "tomato paste", category: "vegetable", attributes: attrs({ form: "paste" }) }, "bls", "Tomatenmark"],
    ["Zwiebel", { de: "Zwiebel", en: "onion", coreDe: "Zwiebel", coreEn: "onion", category: "vegetable", state: "raw" }, "bls", "Speisezwiebel roh"],
    ["Chilipulver", { de: "Chilipulver", en: "chili powder", coreDe: "Chili", coreEn: "chili", category: "spice", attributes: attrs({ form: "powder" }) }, "usda-local", "Spices, chili powder"],
    ["gemahlener Koriander", { de: "Koriander, gemahlen", en: "ground coriander", coreDe: "Koriander", coreEn: "coriander", category: "spice", attributes: attrs({ form: "ground" }) }, "usda-local", "Spices, coriander seed"],
    ["Schwarze Bohne (PR A)", { de: "Schwarze Bohne", en: "black bean", coreDe: "Bohne", coreEn: "bean", category: "legume" }, "usda-local", "Beans, black, mature seeds, raw"],
  ]

  for (const [label, q, provider, record] of FAST_PATH) {
    it(`${label}: resolves to ${provider} "${record}" with ZERO judge calls`, async () => {
      stub({ judge: () => { throw new Error("the judge must not be asked about an accepted record") } })
      const r = await resolve(q)
      expect(r!.fallbackStatus).toBe(provider)
      expect(r!.match.productName).toBe(record)
      expect(calls.judge).toBe(0)
      expect(r!.judge).toBeUndefined()
    })
  }

  it("a mealie-recipe match stays first-class and is never judged", async () => {
    stub()
    // The recipe provider answers from the user's own computed recipe; RECORD_PROVIDERS includes
    // it, so the fast path returns before any pool is built.
    const r = await resolve({ de: "Olivenöl", en: "olive oil", coreDe: "Öl", coreEn: "oil", category: "oil" })
    expect(["mealie-recipe", "bls"]).toContain(r!.fallbackStatus)
    expect(calls.judge).toBe(0)
  })
})

describe("the judge replaces a fabricated estimate with a real record", () => {
  /**
   * A grain neither BLS nor the bundled USDA data knows, supplied only as a low-scoring USDA
   * fixture record: the chain therefore reaches llm-nutrient while a real gate-surviving candidate
   * exists — exactly the T1/T5 shape.
   */
  async function absentFromEveryDatabase() {
    await useUsdaLocalFixture([
      { fdcId: 555001, description: "Freekeh grain, uncooked, ancient heritage cultivar, bulk packed", kcal: 371, protein: 13.6, carbs: 65.2, fat: 7 },
    ])
  }

  it("adopts the selected record and copies its nutrients VERBATIM", async () => {
    await absentFromEveryDatabase()
    stub({ judge: (ids) => `{"decision":"selected","candidateId":"${ids[0]}","confidence":0.8,"reason":"same grain"}` })

    const r = await resolve({ de: "Freekeh", en: "freekeh", coreDe: "Freekeh", coreEn: "freekeh", category: "grain" })
    expect(calls.judge).toBe(1)
    expect(r!.fallbackStatus).toBe("usda-local")
    expect(r!.match.providerId).toBe("555001")
    expect(r!.match.matchReason).toBe("judge-selected")
    // The numbers are the RECORD's, not the model's — the model only ever returned an id.
    expect(r!.match.nutrients.kcalPer100g).toBe(371)
    expect(r!.match.nutrients.proteinPer100g).toBe(13.6)
    expect(r!.match.nutrients.fatPer100g).toBe(7)
    expect(r!.match.confidence).toBeLessThanOrEqual(0.75)
    expect(r!.judge).toMatchObject({ trigger: "gate-suppressed-pool", verdict: "selected", candidates: 1 })
  })

  it("offers candidates that survived the gates but scored below the old rerank floor", async () => {
    await absentFromEveryDatabase()
    let offeredScoreSeen = false
    stub({
      judge: (ids) => {
        offeredScoreSeen = ids.length > 0
        return '{"decision":"none","candidateId":null,"confidence":1,"reason":"x"}'
      },
    })
    await resolve({ de: "Freekeh", en: "freekeh", coreDe: "Freekeh", coreEn: "freekeh", category: "grain" })
    // The record is unusable deterministically (it never became the match) yet was still shown.
    expect(offeredScoreSeen).toBe(true)
  })

  it("asks at most once per ingredient", async () => {
    await absentFromEveryDatabase()
    stub({ judge: () => '{"decision":"none","candidateId":null,"confidence":1,"reason":"x"}' })
    await resolve({ de: "Freekeh", en: "freekeh", coreDe: "Freekeh", coreEn: "freekeh", category: "grain" })
    expect(calls.judge).toBe(1)
  })
})

describe("every non-selection leaves today's behaviour exactly as it was", () => {
  async function fixture() {
    await useUsdaLocalFixture([
      { fdcId: 555001, description: "Freekeh grain, uncooked, ancient heritage cultivar, bulk packed", kcal: 371, protein: 13.6, carbs: 65.2, fat: 7 },
    ])
  }
  const FREEKEH: Q = { de: "Freekeh", en: "freekeh", coreDe: "Freekeh", coreEn: "freekeh", category: "grain" }

  const NON_SELECTIONS: [string, string | Response][] = [
    ["AMBIGUOUS", '{"decision":"ambiguous","candidateId":null,"confidence":0.5,"reason":"two plausible"}'],
    ["NONE", '{"decision":"none","candidateId":null,"confidence":1,"reason":"different food"}'],
    ["a hallucinated candidate id", '{"decision":"selected","candidateId":"usda-local:999999","confidence":0.9,"reason":"made up"}'],
    ["malformed JSON", "{not json at all"],
    ["no JSON at all", "I would pick the first one."],
    ["an unknown verdict", '{"decision":"probably","candidateId":null,"confidence":1,"reason":"x"}'],
  ]

  for (const [label, reply] of NON_SELECTIONS) {
    it(`${label}: falls through to the existing llm-nutrient estimate`, async () => {
      await fixture()
      stub({ judge: () => reply, nutrients: { kcal: 110, protein: 4, carbs: 20, fat: 1.6 } })
      const r = await resolve(FREEKEH)
      expect(r!.fallbackStatus).toBe("llm-nutrient")
      expect(r!.match.nutrients.kcalPer100g).toBe(110)
    })
  }

  it("an HTTP error falls through", async () => {
    await fixture()
    stub({ judge: () => new Response("upstream exploded", { status: 500 }) })
    const r = await resolve(FREEKEH)
    expect(r!.fallbackStatus).toBe("llm-nutrient")
  })

  it("a network failure falls through", async () => {
    await fixture()
    calls = { judge: 0, nutrients: 0 }
    vi.stubGlobal("fetch", vi.fn(async (url: unknown, init?: { body?: string }) => {
      const prompt = String(JSON.parse(String(init?.body ?? "{}")).messages?.[0]?.content ?? "")
      if (String(url).startsWith(config.openFoodFacts.searchBaseUrl)) {
        return new Response(JSON.stringify({ hits: [] }), { status: 200, headers: { "content-type": "application/json" } })
      }
      if (prompt.includes(JUDGE_MARKER)) throw new Error("ECONNRESET")
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ kcal: 110, protein: 4, carbs: 20, fat: 1.6 }) } }] }),
        { status: 200, headers: { "content-type": "application/json" } })
    }))
    const r = await resolve(FREEKEH)
    expect(r!.fallbackStatus).toBe("llm-nutrient")
    expect(r!.match.nutrients.kcalPer100g).toBe(110)
  })

  it("a selection below the confidence floor falls through rather than guessing", async () => {
    await fixture()
    stub({ judge: (ids) => `{"decision":"selected","candidateId":"${ids[0]}","confidence":0.3,"reason":"not sure"}` })
    const r = await resolve(FREEKEH)
    expect(r!.fallbackStatus).toBe("llm-nutrient")
  })

  it("asks nothing at all when no candidate survived the gates", async () => {
    await useUsdaLocalFixture([])
    stub({ judge: () => { throw new Error("nothing to choose between") } })
    const r = await resolve({ de: "Gurkenwasser", en: "cucumber water", coreDe: "Gurke", coreEn: "cucumber water", category: "liquid" })
    expect(calls.judge).toBe(0)
    expect(r!.fallbackStatus).toBe("llm-nutrient")
  })
})

describe("PR A's carrier and identity rules still bind the judge", () => {
  it("Gurkenwasser cannot come back as bottled water — the record never reaches the pool", async () => {
    // The carrier gate HARD-rejects it, and hard-rejected candidates are never offered. So even a
    // judge that wanted to pick it could not: it is not in the set.
    let offered: string[] = []
    stub({
      judge: (ids) => { offered = ids; return `{"decision":"selected","candidateId":"${ids[0]}","confidence":0.9,"reason":"x"}` },
    })
    const r = await resolve({ de: "Gurkenwasser", en: "cucumber water", coreDe: "Gurke", coreEn: "cucumber water", category: "liquid" })
    expect(offered).not.toContain("usda-local:174158")
    expect(r!.match.providerId).not.toBe("174158")
  })

  it("a hard-rejected candidate is never offered, however low the bar", async () => {
    await useUsdaLocalFixture([
      { fdcId: 556001, description: "Soup, cream of mushroom, canned, condensed", kcal: 80, category: "Soups, Sauces, and Gravies" },
    ])
    let offered: string[] = []
    stub({ judge: (ids) => { offered = ids; return '{"decision":"none","candidateId":null,"confidence":1,"reason":"x"}' } })
    await resolve({ de: "Kreuzkümmel", en: "cumin", coreDe: "Kreuzkümmel", coreEn: "cumin", category: "spice" })
    expect(offered).not.toContain("usda-local:556001")
  })
})

describe("the decision is stable and cached", () => {
  it("gives the same answer five times and asks only once", async () => {
    await useUsdaLocalFixture([
      { fdcId: 555001, description: "Freekeh grain, uncooked, ancient heritage cultivar, bulk packed", kcal: 371, protein: 13.6, carbs: 65.2, fat: 7 },
    ])
    stub({ judge: (ids) => `{"decision":"selected","candidateId":"${ids[0]}","confidence":0.8,"reason":"same grain"}` })

    const seen = new Set<string>()
    for (let i = 0; i < 5; i++) {
      __clearProviderCachesForTests() // force the provider chain to run afresh every time
      const r = await resolve({ de: "Freekeh", en: "freekeh", coreDe: "Freekeh", coreEn: "freekeh", category: "grain" })
      seen.add(`${r!.fallbackStatus}|${r!.match.providerId}|${r!.match.nutrients.kcalPer100g}`)
    }
    expect(seen.size).toBe(1)
    expect([...seen][0]).toBe("usda-local|555001|371")
    // Four of the five were answered from the judge decision cache.
    expect(calls.judge).toBe(1)
  })
})

describe("with the judge disabled, PR C is inert", () => {
  it("issues no judge call and returns the deterministic outcome", async () => {
    config.llm.judgeEnabled = false
    await useUsdaLocalFixture([
      { fdcId: 555001, description: "Freekeh grain, uncooked, ancient heritage cultivar, bulk packed", kcal: 371, protein: 13.6, carbs: 65.2, fat: 7 },
    ])
    stub({ judge: () => { throw new Error("must not be asked") } })
    const r = await resolve({ de: "Freekeh", en: "freekeh", coreDe: "Freekeh", coreEn: "freekeh", category: "grain" })
    expect(calls.judge).toBe(0)
    expect(r!.fallbackStatus).toBe("llm-nutrient")
  })
})

// ---------------------------------------------------------------------------------------------

describe("OFF as a verified retail proxy, on the additive path only", () => {
  const OFF_HIT = (over: Record<string, unknown> = {}) => ({
    code: "4061458212588",
    product_name: "Kochsahne 7%Fett",
    brands: ["Milsani", "Aldi"],
    categories_tags: ["en:dairies", "en:creams"],
    nutriments: { "energy-kcal_100g": 85, proteins_100g: 2.9, carbohydrates_100g: 3.9, fat_100g: 7 },
    ...over,
  })

  /** Routes the judge prompt, the nutrient fallback and the OFF proxy search separately. */
  let retailSeenByJudge = false
  const judgeSawRetail = () => retailSeenByJudge

  function stubWithOff(hits: unknown[], judgeReply: (ids: string[]) => string) {
    calls = { judge: 0, nutrients: 0 }
    retailSeenByJudge = false
    let offSearches = 0
    const chat = (content: string) =>
      new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
        status: 200, headers: { "content-type": "application/json" },
      })
    vi.stubGlobal("fetch", vi.fn(async (url: unknown, init?: { body?: string }) => {
      const u = String(url)
      if (u.startsWith(config.openFoodFacts.searchBaseUrl)) {
        offSearches++
        return new Response(JSON.stringify({ hits }), { status: 200, headers: { "content-type": "application/json" } })
      }
      const body = String(init?.body ?? "{}")
      const prompt = String(JSON.parse(body).messages?.[0]?.content ?? "")
      if (prompt.includes(JUDGE_MARKER)) {
        calls.judge++
        const ids = [...String(JSON.parse(body).messages?.[1]?.content ?? "").matchAll(/id=(\S+) \|/g)].map((m) => m[1])
        if (ids.some((i) => i.startsWith("off:"))) retailSeenByJudge = true
        return chat(judgeReply(ids))
      }
      calls.nutrients++
      return chat(JSON.stringify({ kcal: 70, protein: 3, carbs: 4, fat: 4.5 }))
    }))
    return { offSearches: () => offSearches }
  }

  const KOCHSAHNE: Q = {
    de: "Kochsahne 7 % Fett", en: "cooking cream 7% fat", coreDe: "Sahne", coreEn: "cream",
    category: "dairy", foodType: "processed_single_food", attributes: attrs({ fatPercent: 7 }),
  }

  it("replaces a fabricated estimate with a real retail record when nothing local states the number", async () => {
    const off = stubWithOff([OFF_HIT()], (ids) => {
      const target = ids.find((i) => i.startsWith("off:"))!
      return `{"decision":"selected","candidateId":"${target}","confidence":0.9,"reason":"exact stated fat percentage"}`
    })
    const r = await resolve(KOCHSAHNE)
    expect(off.offSearches()).toBeGreaterThan(0)
    expect(r!.fallbackStatus).toBe("off")
    expect(r!.match.providerId).toBe("4061458212588")
    // Nutrients are the product's, copied verbatim — the model returned an id and nothing else.
    expect(r!.match.nutrients.kcalPer100g).toBe(85)
    expect(r!.match.nutrients.fatPer100g).toBe(7)
  })

  it("does NOT query OFF for an ordinary ingredient a local database already answers", async () => {
    const off = stubWithOff([OFF_HIT()], () => { throw new Error("the judge must not be asked") })
    const r = await resolve({ de: "Tomate", en: "tomato", coreDe: "Tomate", coreEn: "tomato", category: "vegetable", state: "raw" })
    expect(r!.fallbackStatus).toBe("bls")
    expect(off.offSearches()).toBe(0)
    expect(calls.judge).toBe(0)
  })

  it("does NOT query OFF for a numeric claim a local record already states", async () => {
    const off = stubWithOff([OFF_HIT()], (ids) => `{"decision":"selected","candidateId":"${ids[0]}","confidence":0.9,"reason":"x"}`)
    await resolve({
      de: "Rinderhackfleisch 10 % Fett", en: "ground beef 10% fat", coreDe: "Rinderhackfleisch",
      coreEn: "ground beef", category: "meat", state: "raw", attributes: attrs({ fatPercent: 10 }),
    })
    // USDA files the 90/10 grade as a record of its own, so the JUDGE never opens a proxy route
    // for it. (The ordinary OFF provider is still part of the chain and may run on its own terms;
    // what is asserted here is that no proxy search was added on top of it.)
    expect(off.offSearches()).toBeLessThanOrEqual(1)
    expect(judgeSawRetail()).toBe(false)
  })

  it("keeps the strict filter: a product with no energy, or the wrong measured fat, never reaches the judge", async () => {
    let offered: string[] = []
    stubWithOff(
      [
        OFF_HIT({ code: "111", nutriments: { proteins_100g: 3 } }),                                   // no energy
        OFF_HIT({ code: "222", nutriments: { "energy-kcal_100g": 300, fat_100g: 30 } }),               // 30% vs 7%
        OFF_HIT({ code: "333", product_name: "Schoko-Riegel", nutriments: { "energy-kcal_100g": 500, fat_100g: 7 } }), // core absent from name
        OFF_HIT(),                                                                                     // the genuine one
      ],
      (ids) => { offered = ids; return '{"decision":"none","candidateId":null,"confidence":1,"reason":"x"}' },
    )
    await resolve(KOCHSAHNE)
    expect(offered).toContain("off:4061458212588")
    for (const rejected of ["off:111", "off:222", "off:333"]) expect(offered).not.toContain(rejected)
  })

  it("an OFF search failure changes nothing — the deterministic fallback stands", async () => {
    calls = { judge: 0, nutrients: 0 }
    vi.stubGlobal("fetch", vi.fn(async (url: unknown, init?: { body?: string }) => {
      if (String(url).startsWith(config.openFoodFacts.searchBaseUrl)) throw new Error("ECONNRESET")
      const prompt = String(JSON.parse(String(init?.body ?? "{}")).messages?.[0]?.content ?? "")
      if (prompt.includes(JUDGE_MARKER)) {
        calls.judge++
        return new Response(JSON.stringify({ choices: [{ message: { content: '{"decision":"none","candidateId":null,"confidence":1,"reason":"x"}' } }] }), { status: 200 })
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ kcal: 70, protein: 3, carbs: 4, fat: 4.5 }) } }] }), { status: 200 })
    }))
    const r = await resolve(KOCHSAHNE)
    expect(r!.fallbackStatus).toBe("llm-nutrient")
    expect(r!.match.nutrients.kcalPer100g).toBe(70)
  })

  it("never lets a retail record displace an ACCEPTED database record", async () => {
    const off = stubWithOff([OFF_HIT({ product_name: "Mageres Rinderhackfleisch zum Braten", code: "4313249214975", nutriments: { "energy-kcal_100g": 163, fat_100g: 8.9, proteins_100g: 21 } })],
      (ids) => `{"decision":"selected","candidateId":"${ids[0]}","confidence":1,"reason":"x"}`)
    const r = await resolve({
      de: "Rinderhackfleisch, mager", en: "lean ground beef", coreDe: "Rinderhackfleisch",
      coreEn: "ground beef", category: "meat", state: "raw",
    })
    // BLS accepts a record for this query, so the fast path returns before any pool is built.
    expect(r!.fallbackStatus).toBe("bls")
    expect(r!.match.unmetAttributes).toEqual(["reduced-fat"])
    // The judge is never asked at all, so no retail record can reach this resolution — the
    // unmet-attribute replacement path is deliberately not part of this change.
    expect(calls.judge).toBe(0)
  })
})
