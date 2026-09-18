import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest"
import { config } from "../src/config.js"
import { initCache, clearLlmCache, __clearProviderCachesForTests } from "../src/utils/cache.js"
import { resolveNutrients } from "../src/services/nutrient-resolver.js"
import { buildResolverQuery } from "../src/services/resolver-query.js"
import { UNKNOWN_ATTRIBUTES, type FoodAttributes, type IngredientClassification } from "../src/types.js"

/**
 * OPEN FOOD FACTS AS A LAST RESORT, and the curated-pointer bugs the same production audit found.
 *
 * Measured on the deployed v1.3.1 corpus: 226 ingredient rows, 15 unresolved. Most of those are
 * branded or specialty foods that BLS and USDA simply do not stock — `Leerdammer Leger`,
 * `Hoisin-Sauce`, `Reisessig`, `Proteinpulver` — and OFF was never even asked about them. The
 * judge's OFF route existed, but it was justified only for an unresolved PROPERTY claim
 * ("mager", "7 %"); an ingredient that claims no property and has no local record answered
 * `propertyKind: "none"` and stopped there.
 *
 * So the route is now justified on a second, different ground: nothing answered at all. The
 * safety model is unchanged and is the whole point —
 *
 *   retrieval is not acceptance: candidates must survive the filter AND be selected by the judge;
 *   the model returns an id, never a number: every nutrient is the chosen record's own;
 *   NO_SAFE_MATCH stays a correct answer, and unresolved stays better than a wrong match.
 */

const JUDGE_MARKER = "SEMANTIC JUDGE"
const attrs = (o: Partial<FoodAttributes> = {}): FoodAttributes => ({ ...UNKNOWN_ATTRIBUTES, ...o })

interface Q { de: string; en: string; coreDe: string | null; coreEn: string | null; category?: string | null; state?: string; foodType?: string; attributes?: FoodAttributes }

const resolve = (q: Q) => resolveNutrients({
  foodName: q.en, structuredName: q.de, canonicalGerman: q.de, brand: null,
  category: q.category ?? null, state: q.state ?? "unknown", foodType: q.foodType ?? "simple",
  coreFoodGerman: q.coreDe, coreFoodEnglish: q.coreEn, route: "generic",
  attributes: q.attributes ?? attrs(),
  evidence: { german: true, english: true, core: true, brand: false },
} as never, "generic")

let calls: { judge: number; nutrients: number; offSearches: number }
let offeredToJudge: string[] = []
let judgePrompt = ""

/** Routes the OFF search, the judge prompt and the nutrient generator separately. */
function stubWithOff(hits: unknown[], judgeReply: (ids: string[]) => string) {
  calls = { judge: 0, nutrients: 0, offSearches: 0 }
  offeredToJudge = []
  judgePrompt = ""
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
    const system = String(body.messages?.[0]?.content ?? "")
    const user = String(body.messages?.[1]?.content ?? "")
    if (system.includes(JUDGE_MARKER)) {
      calls.judge++
      judgePrompt = user
      offeredToJudge = [...user.matchAll(/id=(\S+) \|/g)].map((m) => m[1])
      return chat(judgeReply(offeredToJudge))
    }
    calls.nutrients++
    return chat(JSON.stringify({ kcal: 999, protein: 9, carbs: 9, fat: 9 }))
  }))
}

const hit = (over: Record<string, unknown> = {}) => ({
  code: "4388860276916",
  product_name: "Leerdammer Leger",
  brands: ["Leerdammer"],
  categories_tags: ["en:dairies", "en:cheeses"],
  nutriments: { "energy-kcal_100g": 262, proteins_100g: 27, carbohydrates_100g: 0.1, fat_100g: 17 },
  ...over,
})

const selectOff = (ids: string[]) => {
  const target = ids.find((i) => i.startsWith("off:"))
  return target
    ? `{"decision":"selected","candidateId":"${target}","confidence":0.9,"reason":"same product"}`
    : '{"decision":"none","candidateId":null,"confidence":1,"reason":"no candidate"}'
}

beforeAll(async () => { await initCache() })

beforeEach(() => {
  clearLlmCache()
  __clearProviderCachesForTests()
  config.llm.enabled = true
  config.llm.apiKey = "test-key"
  config.llm.judgeEnabled = true
  config.llm.rerankEnabled = false
  // Production runs with generated nutrients OFF. Every case here must hold under that setting,
  // because selecting a real record and inventing one are different capabilities.
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

const LEERDAMMER: Q = { de: "Leerdammer Leger", en: "Leerdammer cheese", coreDe: "Käse", coreEn: "cheese", category: "dairy" }

describe("a branded product BLS and USDA do not stock now reaches OFF", () => {
  it("resolves Leerdammer Leger to its real barcode, with the product's own nutrients", async () => {
    // Production left this unresolved. OFF holds the exact label; the English core "cheese" is
    // what hid it, because a cheese label has no reason to print the word.
    stubWithOff([hit()], selectOff)
    const r = await resolve(LEERDAMMER)

    expect(calls.offSearches, "OFF must actually be consulted").toBeGreaterThan(0)
    expect(r?.fallbackStatus).toBe("off")
    expect(r?.match.providerId, "the real barcode is the provenance").toBe("4388860276916")
    expect(r?.match.productName).toBe("Leerdammer Leger")
    expect(r?.match.matchReason).toBe("judge-selected")
    // Verbatim from the record. The model was asked for an id and returned an id.
    expect(r?.match.nutrients.kcalPer100g).toBe(262)
    expect(r?.match.nutrients.proteinPer100g).toBe(27)
    expect(r?.match.nutrients.fatPer100g).toBe(17)
    expect(calls.nutrients, "no generated nutrients, ever").toBe(0)
  })

  it("brand alone never disqualifies a candidate for an unbranded query", async () => {
    // "Hoisin-Sauce" did not name a manufacturer, so "Hoisin Sauce - Flying Goose" is a perfectly
    // good answer. This is the rule the ordinary generic route deliberately does NOT apply.
    stubWithOff([hit({
      code: "8853100010012", product_name: "Hoisin Sauce", brands: ["Flying Goose"],
      categories_tags: ["en:plant-based-foods-and-beverages", "en:sauces"],
      nutriments: { "energy-kcal_100g": 228, proteins_100g: 2.4, carbohydrates_100g: 48, fat_100g: 1.2 },
    })], selectOff)
    const r = await resolve({ de: "Hoisin-Sauce", en: "hoisin sauce", coreDe: "Sauce", coreEn: "sauce" })

    expect(r?.fallbackStatus).toBe("off")
    expect(r?.match.providerId).toBe("8853100010012")
    expect(r?.match.nutrients.kcalPer100g).toBe(228)
  })

  it("a semantically different product is still refused, however well it scores lexically", async () => {
    // Shares the word "Sauce" and nothing else. The filter must not offer it; if it somehow does,
    // the judge declining is the second line of defence, and unresolved is the right outcome.
    stubWithOff([hit({
      code: "111", product_name: "Sojasauce", brands: ["Kikkoman"],
      categories_tags: ["en:sauces"],
      nutriments: { "energy-kcal_100g": 80, proteins_100g: 10, carbohydrates_100g: 8, fat_100g: 0.1 },
    })], () => '{"decision":"none","candidateId":null,"confidence":1,"reason":"soy sauce is not hoisin"}')
    const r = await resolve({ de: "Hoisin-Sauce", en: "hoisin sauce", coreDe: "Sauce", coreEn: "sauce" })

    expect(offeredToJudge.filter((i) => i.startsWith("off:")), "shares only the class word").toHaveLength(0)
    expect(r, "unresolved beats a wrong product").toBeNull()
    expect(calls.nutrients).toBe(0)
  })
})

describe("the last resort cannot invent anything", () => {
  it("NO_SAFE_MATCH leaves the ingredient unresolved", async () => {
    stubWithOff([hit()], () => '{"decision":"none","candidateId":null,"confidence":1,"reason":"not the same cheese"}')
    const r = await resolve(LEERDAMMER)
    expect(r).toBeNull()
    expect(calls.nutrients).toBe(0)
  })

  it("a candidate the model invents is refused — it may only pick from what it was shown", async () => {
    stubWithOff([hit()], () => '{"decision":"selected","candidateId":"off:9999999999","confidence":0.99,"reason":"made up"}')
    const r = await resolve(LEERDAMMER)
    expect(r, "an id that was never offered selects nothing").toBeNull()
  })

  it("the judge is shown records and asked for an id, never for nutrients", async () => {
    stubWithOff([hit()], selectOff)
    await resolve(LEERDAMMER)
    expect(judgePrompt).toContain("Leerdammer Leger")
    expect(judgePrompt.toLowerCase()).not.toMatch(/invent|estimate the (calor|energy)/)
  })

  it("a product with no energy value never becomes a candidate", async () => {
    stubWithOff([hit({ nutriments: { proteins_100g: 27 } })], selectOff)
    const r = await resolve(LEERDAMMER)
    expect(offeredToJudge.filter((i) => i.startsWith("off:"))).toHaveLength(0)
    expect(r).toBeNull()
  })

  it("works with LLM_NUTRIENT_ENABLED=false — selection and generation are separate capabilities", async () => {
    expect(config.llm.nutrientEnabled).toBe(false)
    stubWithOff([hit()], selectOff)
    const r = await resolve(LEERDAMMER)
    expect(r?.fallbackStatus).toBe("off")
    expect(calls.nutrients).toBe(0)
  })

  it("is not consulted at all when the judge is disabled", async () => {
    config.llm.judgeEnabled = false
    stubWithOff([hit()], selectOff)
    const r = await resolve(LEERDAMMER)
    expect(r).toBeNull()
    expect(calls.judge).toBe(0)
  })
})

describe("the last resort never displaces a real database record", () => {
  it("an ingredient BLS answers never triggers an OFF search", async () => {
    stubWithOff([hit()], () => { throw new Error("the judge must not be asked") })
    const r = await resolve({ de: "Tomate", en: "tomato", coreDe: "Tomate", coreEn: "tomato", category: "vegetable", state: "raw" })
    expect(r?.fallbackStatus).toBe("bls")
    expect(calls.offSearches).toBe(0)
    expect(calls.judge).toBe(0)
  })
})

/**
 * The curated pointers the same audit found being dropped, and the ones that must keep being
 * dropped. Whole-recipe classification words the same ingredient differently from recipe to
 * recipe, which is how `Koriander frisch` resolved in three recipes and not in a fourth.
 */
describe("a curated pointer survives the model rewording the ingredient", () => {
  const ai = (o: Partial<IngredientClassification>): IngredientClassification => ({
    index: 0, canonicalGerman: "", canonicalEnglish: "", coreFoodGerman: null, coreFoodEnglish: null,
    brand: null, category: null, state: "unknown", attributes: UNKNOWN_ATTRIBUTES,
    foodType: "simple", route: "generic", llmClassified: true, ...o,
  } as IngredientClassification)

  const viaClassifier = async (name: string, c: Partial<IngredientClassification>) => {
    const built = buildResolverQuery(name, ai(c), {})
    return { built, resolved: await resolveNutrients(built.query, built.route) }
  }

  beforeEach(() => { config.llm.judgeEnabled = false })

  it.each([
    ["Koriandergrün", "fresh coriander leaves"],
    ["Korianderblätter", "coriander leaves"],
    ["frischer Koriander", "fresh coriander"],
    ["Koriander frisch", "fresh coriander"],
  ])("Koriander frisch keeps USDA 169997 when the model calls it %j", async (canonicalGerman, canonicalEnglish) => {
    const { built, resolved } = await viaClassifier("Koriander frisch", {
      canonicalGerman, canonicalEnglish, coreFoodGerman: canonicalGerman, coreFoodEnglish: canonicalEnglish,
      attributes: attrs({ form: "leaf", preservation: "fresh" }),
    })
    expect(built.query.vocabulary?.preferred, "the reviewed pointer must survive").toBeDefined()
    expect(resolved?.match.providerId).toBe("169997")
    expect(resolved?.match.matchReason).toMatch(/^recipe-vocabulary:/)
  })

  it.each([
    ["Mehl", "Gerstenmehl", "barley flour", "C214100"],
    ["Milch", "Magermilch", "skim milk", "M111300"],
    ["Pflanzenöl", "Rapsöl", "rapeseed oil", "172370"],
  ])("%s still drops its pointer when the model names a different food (%s)", async (name, canonicalGerman, canonicalEnglish, mustNot) => {
    const { built, resolved } = await viaClassifier(name, {
      canonicalGerman, canonicalEnglish, coreFoodGerman: canonicalGerman, coreFoodEnglish: canonicalEnglish,
    })
    expect(built.query.vocabulary?.preferred, "a different food is a real contradiction").toBeUndefined()
    expect(resolved?.match.providerId ?? null).not.toBe(mustNot)
  })
})

/**
 * Resolution is only useful if the WEIGHT is right. Two of the production misses never reached a
 * provider at all: their unit converted to no grams, so the estimator dropped them before
 * resolution and reported them exactly like a failed match.
 */
describe("units that silently dropped an ingredient before it could resolve", () => {
  let convertToGrams: typeof import("../src/services/unit-converter.js").convertToGrams
  beforeAll(async () => { ({ convertToGrams } = await import("../src/services/unit-converter.js")) })

  const unit = (name: string) => ({
    id: name, name, pluralName: null, abbreviation: null, standardQuantity: null, standardUnit: null,
  })

  it.each([
    ["1 Stück Gemüsebrühwürfel", 1, "Stück", "Gemüsebrühwürfel", 10],
    ["1 Würfel Gemüsebrühwürfel", 1, "Würfel", "Gemüsebrühwürfel", 10],
    ["2 Scheiben Leerdammer Leger", 2, "Scheibe", "Leerdammer Leger", 40],
    ["2 Scheiben Gouda", 2, "Scheibe", "Gouda", 40],
    // Latent: the yeast entry has declared a `würfel` weight all along, but the unit was never
    // routed to the piece table, so it converted to nothing.
    ["1 Würfel Hefe", 1, "Würfel", "Hefe", 42],
  ])("%s converts to a real weight", (_label, qty, unitName, food, grams) => {
    expect(convertToGrams(qty, unit(unitName) as never, food)?.grams).toBe(grams)
  })

  it.each([
    ["Toastbrot", "Scheibe"],
    ["Schinken", "Scheibe"],
    ["Salami", "Scheibe"],
  ])("a slice of %s is still not guessed", (food, unitName) => {
    // A slice weight is only stated where it is stable. Bread and cold cuts differ by 2-3x, and a
    // wrong weight is a wrong recipe total — an unresolved weight is the honest answer.
    expect(convertToGrams(2, unit(unitName) as never, food)).toBeNull()
  })

  it("the dry cube and the prepared broth stay different foods", async () => {
    // 10 g of cube is not 500 ml of broth. The conversion must not make them interchangeable.
    const cube = convertToGrams(1, unit("Stück") as never, "Gemüsebrühwürfel")
    const broth = convertToGrams(500, unit("Milliliter") as never, "Gemüsebrühe")
    expect(cube?.grams).toBe(10)
    expect(broth?.grams).toBe(500)
  })
})
