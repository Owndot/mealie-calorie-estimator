import { beforeEach, describe, expect, it, vi } from "vitest"
import { estimateRecipe, buildNutritionPatch, computeIngredientHash, parseYield, resolveServings } from "../src/services/estimator.js"
import { contextForName, interpretIngredient, normalizeFoodText, normalizeIngredientDescriptors, nutrientCacheKey } from "../src/services/ingredient-context.js"
import { genericNutrients } from "../src/services/generic-foods.js"
import { convertToGrams } from "../src/services/unit-converter.js"
import { lookupNutrients } from "../src/services/off-client.js"
import { scoreOffMatch } from "../src/services/off-matching.js"
import { validateProfile, recipeWarnings } from "../src/services/nutrition-validation.js"
import type { MealieIngredient, MealieRecipe, NutrientSet } from "../src/types.js"

const cache = vi.hoisted(() => new Map<string, { nutrients: NutrientSet; productName: string; confidence: string }>())
vi.mock("../src/utils/cache.js", () => ({
  getCachedOffLookup: (key: string) => cache.get(key),
  setCachedOffLookup: (key: string, value: { nutrients: NutrientSet; productName: string; confidence: string }) => cache.set(key, value),
}))
vi.mock("../src/services/llm-estimator.js", () => ({ estimateGrams: vi.fn(async () => null), estimateNutrients: vi.fn(async () => null) }))
vi.mock("../src/utils/rate-limiter.js", () => ({ waitForRateLimit: vi.fn(), RateLimitType: { Search: "search" } }))

export function ingredient(name: string, quantity: number, unitName: string | null = "g", note: string | null = null): MealieIngredient {
  return { quantity, food: { id: "", name, pluralName: null, aliases: [] }, note, display: "", originalText: null, title: null,
    unit: unitName ? { id: "", name: unitName, abbreviation: null, pluralName: null, standardQuantity: null, standardUnit: null } : null }
}
export function recipe(ingredients: MealieIngredient[], servings = 1): MealieRecipe {
  return { name: "Regression", slug: "regression", recipeIngredient: ingredients, recipeYield: `${servings} Portionen`, recipeServings: servings, tags: [], extras: {}, nutrition: null }
}
const hit = (name: string, kcal: number, sodium = 0) => {
  const fat = Math.min(100, kcal / 9)
  const carbs = Math.max(0, (kcal - fat * 9) / 4)
  return { product_name: name, nutriments: {
    "energy-kcal_100g": kcal, "proteins_100g": 0, "carbohydrates_100g": carbs,
    "fat_100g": fat, "saturated-fat_100g": 0, "sodium_100g": sodium,
  } }
}
const response = (hits: unknown[]) => new Response(JSON.stringify({ hits }))
beforeEach(() => {
  cache.clear()
  vi.restoreAllMocks()
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => response([]))
})

describe("real recipe reference calculations", () => {
  it("estimates dry Wachtelbohnen from soaking context", async () => {
    const input = recipe([ingredient("Wachtelbohnen", 500), ingredient("Butter", 30), ingredient("Sonnenblumenöl", 5, "ml"), ingredient("Zwiebeln", 200)], 4)
    input.recipeInstructions = [{ text: "Die Bohnen über Nacht in Wasser einweichen." }]
    const result = await estimateRecipe(input)
    expect(result.matchedCount).toBe(4)
    expect(result.matchedIngredients[0].context?.state).toBe("dry")
    expect(result.matchedIngredients[0].context?.reason).toContain("soaking")
    expect(result.totals?.kcal).toBeCloseTo(2069.88, 1)
    expect(result.perServing?.kcal).toBeCloseTo(517.47, 1)
    expect(result.perServing?.sodiumMg).toBeLessThan(100)
  })
  it("distinguishes canned, drained, cooked and dry kidney beans", async () => {
    const kcal: Record<string, number> = {}
    for (const [state, name] of Object.entries({ dry: "Kidneybohnen trocken", cooked: "Kidneybohnen gekocht", canned: "Kidneybohnen aus der Dose", drained: "Kidneybohnen abgetropft" })) {
      const result = await estimateRecipe(recipe([ingredient(name, 400)]))
      kcal[state] = result.totals!.kcal!
    }
    expect(kcal).toEqual({ dry: 1348, cooked: 508, canned: 324, drained: 496 })
  })
  it("uses dry rice quantities even though cooking occurs later", async () => {
    const input = recipe([ingredient("Basmati-Reis", 100)])
    input.recipeInstructions = ["Den Reis in Wasser kochen."]
    const result = await estimateRecipe(input)
    expect(result.totals?.kcal).toBe(365)
  })
  it("uses generic full-fat coconut milk before any coconut drink candidate", async () => {
    vi.mocked(fetch).mockResolvedValue(response([hit("coconut milk drink", 20)]))
    const result = await estimateRecipe(recipe([ingredient("Kokosmilch", 200, "ml")]))
    expect(result.matchedIngredients[0].source).toBe("generic")
    expect(result.totals?.kcal).toBe(394)
    expect(fetch).not.toHaveBeenCalled()
  })
  it.each([[1, 393], [2, 786]])("calculates %d g salt as %d mg sodium without network", async (grams, sodium) => {
    const result = await estimateRecipe(recipe([ingredient("Salz", grams)]))
    expect(result.totals?.sodiumMg).toBe(sodium)
    expect(result.totals?.kcal).toBe(0)
    expect(fetch).not.toHaveBeenCalled()
    expect(buildNutritionPatch(result, "hash", "1 Portion").nutrition.sodiumContent).toBe(String(sodium))
  })
  it("uses a small pinch and divides sodium exactly once", async () => {
    const result = await estimateRecipe(recipe([ingredient("Salz", 1, "Prise")], 2))
    expect(result.totals?.sodiumMg).toBe(98.25)
    expect(result.perServing?.sodiumMg).toBe(49.125)
    expect(buildNutritionPatch(result, "hash", "2 Portionen").nutrition.sodiumContent).toBe("49")
  })
  it("estimates 2 tbsp olive oil near 240 kcal", async () => {
    const result = await estimateRecipe(recipe([ingredient("Olivenöl", 2, "EL")]))
    expect(result.matchedIngredients[0].grams).toBe(27)
    expect(result.totals?.kcal).toBeCloseTo(238.68)
  })
  it.each([["onion", 1, "Stück", 110], ["Zwiebeln", 1, null, 110], ["Knoblauch", 2, "Zehe", 6]])(
    "uses typical edible piece weight for %s", async (name, quantity, unit, grams) => {
      const result = await estimateRecipe(recipe([ingredient(name, quantity, unit)]))
      expect(result.matchedIngredients[0].grams).toBe(grams)
    },
  )
  it("uses different oil/flour and salt/herb spoon weights", () => {
    const grams = (name: string, unit: string) => convertToGrams(1, ingredient(name, 1, unit).unit, contextForName(name))!
    expect(grams("Olivenöl", "EL")).toBeCloseTo(13.6, 0)
    expect(grams("Mehl", "EL")).toBeLessThan(9)
    expect(grams("Salz", "TL")).toBe(6)
    expect(grams("getrockneter Thymian", "TL")).toBe(1)
  })
})

describe("state interpretation and aliases", () => {
  it.each([
    ["Wachtelbohnen", "pinto beans", "dry"], ["Pintobohnen", "pinto beans", "dry"],
    ["weiße Zwiebel, gewürfelt", "onion", "raw"], ["rote Zwiebel", "red onion", "raw"],
    ["Knoblauchzehen", "garlic", "raw"], ["getrockneter Thymian", "thyme", "dry"],
    ["frischer Koriander", "coriander leaves", "fresh"], ["Koriandersamen", "coriander seeds", "unspecified"],
    ["Koriander", "coriander", "unspecified"], ["Petersilie", "parsley", "fresh"],
    ["Kidneybohnen abgetropft", "kidney beans", "drained"], ["Reis gekocht", "rice", "cooked"],
    ["Sahne", "cream", "unspecified"], ["Kochsahne", "cooking cream", "unspecified"],
    ["geriebener Parmesan", "parmesan", "unspecified"], ["tiefgekühlte Tomaten", "tomato", "frozen"],
  ])("interprets %s", (name, canonicalName, state) => expect(contextForName(name)).toMatchObject({ canonicalName, state }))
  it("uses original ingredient text and can units", () => {
    const input = ingredient("Kidneybohnen", 400)
    input.originalText = "400 g Kidneybohnen, abgetropft"
    expect(interpretIngredient(input).state).toBe("drained")
    expect(interpretIngredient(ingredient("Kidneybohnen", 1, "Dose")).state).toBe("canned")
  })
  it.each([
    ["Kidneybohnen a. d. Dose", "kidney beans", "canned"],
    ["Kidneybohnen aus der Dose", "kidney beans", "canned"],
    ["Kidneybohnen, abgetropft", "kidney beans", "drained"],
    ["Kichererbsen aus der Dose", "chickpeas", "canned"],
    ["Tomaten gehackt", "tomato", "raw"],
    ["Spinat TK", "spinat", "frozen"],
    ["Kartoffeln gekocht", "potato", "cooked"],
    ["Reis gekocht", "rice", "cooked"],
    ["getrocknete Kidneybohnen", "kidney beans", "dry"],
    ["Getrocknete Tomate in Öl", "tomato", "dry"],
    ["sun-dried tomatoes in oil", "tomato", "dry"],
    ["getrocknete Tomaten, abgetropft", "tomato", "dry"],
    ["geröstete Tomaten in Öl", "tomato", "cooked"],
    ["Artischocken in Öl", "artischocken", "unspecified"],
    ["Oliven in Lake", "oliven", "unspecified"],
    ["eingelegte Gurken", "gurken", "unspecified"],
    ["roasted peppers in brine", "peppers", "cooked"],
  ])("normalizes descriptor variant %s", (name, canonicalName, state) => {
    expect(contextForName(name)).toMatchObject({ canonicalName, state })
  })
  it("keeps preservation semantics in the nutrient query without changing the primary state", () => {
    const oil = contextForName("Getrocknete Tomate in Öl")
    const plain = contextForName("getrocknete Tomaten")
    expect(oil).toMatchObject({ canonicalName: "tomato", state: "dry", descriptorNotes: ["in oil"] })
    expect(oil.query).toContain("in oil")
    expect(plain.query).not.toContain("in oil")
    expect(oil.query).not.toBe(plain.query)
  })
  it("separates cache identities by state and preservation descriptors", () => {
    expect(nutrientCacheKey("llm", contextForName("Getrocknete Tomate in Öl")))
      .not.toBe(nutrientCacheKey("llm", contextForName("getrocknete Tomaten")))
    expect(nutrientCacheKey("off", contextForName("Oliven in Lake")))
      .not.toBe(nutrientCacheKey("off", contextForName("Oliven")))
  })
  it.each([
    ["Kochsahne 7%", 7],
    ["Sahne 15% Fett", 15],
    ["Milch 1,5%", 1.5],
  ])("retains explicit fat descriptor for %s", (name, percentage) => {
    expect(contextForName(name).fatPercentage).toBe(percentage)
  })
  it("keeps packaging and preparation notes separate from the base identity", () => {
    expect(normalizeIngredientDescriptors("Tomaten, gehackt in Öl")).toMatchObject({
      baseName: "tomaten",
      states: [],
      notes: ["chopped", "in oil"],
    })
    expect(normalizeFoodText({ unexpected: "runtime value" })).toBe("")
  })
  it("does not crash OFF scoring when optional metadata is not a string", async () => {
    vi.mocked(fetch).mockResolvedValue(response([hit("Kidneybohnen", 337)]))
    const result = await lookupNutrients("Kidneybohnen")
    expect(result.matched).toBe(true)
    expect(scoreOffMatch({ ...contextForName("Kidneybohnen"), brand: "Example" }, "Kidneybohnen", undefined, { invalid: true } as unknown as string)).toBe(0)
  })
  it("does not let recipe instructions override explicit canned beans", () => {
    expect(interpretIngredient(ingredient("Bohnen", 400, "g", "aus der Dose"), ["Die Bohnen über Nacht einweichen."]).state).toBe("canned")
  })
  it("does not interpret unrelated soaking or green beans as dry mature beans", () => {
    expect(interpretIngredient(ingredient("Bohnen", 100), ["Rosinen über Nacht einweichen."]).state).toBe("unspecified")
    expect(contextForName("grüne Bohnen").state).not.toBe("dry")
  })
  it("rejects conflicting dry/cooked clues", async () => {
    const result = await estimateRecipe(recipe([ingredient("Reis gekocht", 100, "g", "trocken")]))
    expect(result.matchedCount).toBe(0)
    expect(fetch).not.toHaveBeenCalled()
  })
  it("versioned hash includes state-bearing notes, instructions and standard conversions", () => {
    const a = recipe([ingredient("Bohnen", 100)])
    const first = computeIngredientHash(a)
    a.recipeIngredient[0].note = "abgetropft"
    expect(computeIngredientHash(a)).not.toBe(first)
    a.recipeIngredient[0].note = null
    a.recipeInstructions = ["Bohnen über Nacht einweichen"]
    expect(computeIngredientHash(a)).not.toBe(first)
  })
})

describe("candidate selection and caches", () => {
  it("finds a trustworthy later candidate instead of accepting the first", async () => {
    vi.mocked(fetch).mockResolvedValue(response([hit("Kidney beans chili ready meal", 100), hit("kidney beans cooked", 127), hit("kidney beans dry", 337)]))
    const result = await lookupNutrients("Kidneybohnen")
    expect(result.productName).toBe("kidney beans dry")
    expect(result.nutrients?.kcalPer100g).toBe(337)
    expect(String(vi.mocked(fetch).mock.calls[0][0])).toContain("page_size=10")
  })
  it("keeps dry and cooked profiles separate and reuses only matching cache keys", async () => {
    vi.mocked(fetch).mockImplementation(async () => response([hit("rice dry", 365), hit("rice cooked", 130)]))
    expect((await lookupNutrients("Reis trocken")).nutrients?.kcalPer100g).toBe(365)
    expect((await lookupNutrients("Reis gekocht")).nutrients?.kcalPer100g).toBe(130)
    expect((await lookupNutrients("rice dry")).nutrients?.kcalPer100g).toBe(365)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(nutrientCacheKey("off", contextForName("rice dry"))).not.toBe(nutrientCacheKey("llm", contextForName("rice dry")))
  })
  it("rejects an unlabelled cooked profile for a dry staple", async () => {
    vi.mocked(fetch).mockResolvedValue(response([hit("Basmati rice", 130)]))
    expect((await lookupNutrients("Basmati-Reis")).matched).toBe(false)
  })
  it("checks nutrients even when the product name is correct", async () => {
    vi.mocked(fetch).mockResolvedValue(response([hit("Kidneybohnen", 337, 400)]))
    expect((await lookupNutrients("Kidneybohnen")).matched).toBe(false)
  })
  it("converts per-100ml oil data to a per-100g profile with known density", async () => {
    vi.mocked(fetch).mockResolvedValue(response([{ ...hit("olive oil", 795.6), nutrition_data_per: "100ml" }]))
    const result = await lookupNutrients("Olivenöl")
    expect(result.matched).toBe(true)
    expect(result.nutrients?.kcalPer100g).toBeCloseTo(884)
    expect(fetch).toHaveBeenCalledOnce()
  })
})

describe("servings and recipe validation", () => {
  it.each([["4 Portionen", 4], ["4 servings", 4], ["4–6 Portionen", 5], ["2,5 Portionen", 2.5], ["2.5 servings", 2.5], ["2,5–3,5", 3], ["0", null], ["-2", null], ["6–4", null]])(
    "parses yield %s", (text, result) => expect(parseYield(text)).toBe(result),
  )
  it("prefers structured servings and does not treat a mass yield as servings", () => {
    const r = recipe([], 4); r.recipeYield = "1 kg"
    expect(resolveServings(r)).toBe(4)
    r.recipeServings = null
    expect(resolveServings(r)).toBeNull()
    r.recipeYield = "2,5 Portionen"
    expect(resolveServings(r)).toBe(2.5)
  })
  it("logs suspicious serving values and omits clearly absurd patch fields", async () => {
    const result = await estimateRecipe(recipe([ingredient("Salz", 200)]))
    expect(result.warnings?.some(w => w.includes("5000 mg"))).toBe(true)
    expect(buildNutritionPatch(result, "hash", "1 Portion").nutrition.sodiumContent).toBeUndefined()
    expect(recipeWarnings({ ...result.perServing!, kcal: 4000 })).toContain("Calories exceed 3000 kcal per serving; verify yield and quantities")
  })
  it("validates every bundled reference profile", () => {
    for (const name of ["Wachtelbohnen", "pinto beans cooked", "pinto beans canned", "pinto beans drained", "Kidneybohnen", "kidney beans cooked", "kidney beans canned", "kidney beans drained", "rice dry", "rice cooked", "Butter", "Olivenöl", "Sonnenblumenöl", "Kokosöl", "Kokosmilch", "Zwiebeln", "Knoblauch", "Mehl", "Kreuzkümmel", "Currypulver", "thyme dry", "thyme fresh", "Petersilie", "frischer Koriander", "Koriandersamen", "Pfeffer", "Ingwer", "Aubergine", "Tomaten", "Parmesan", "Tomatenmark"]) {
      const profile = genericNutrients(contextForName(name))
      expect(profile, name).not.toBeNull()
      expect(validateProfile(profile!), name).toEqual([])
    }
  })
})

it("preserves low-fat or seasoned qualifiers from notes", () => {
  expect(interpretIngredient(ingredient("Kokosmilch", 200, "ml", "light")).canonicalName).toBe("coconut milk light")
  expect(genericNutrients(interpretIngredient(ingredient("Salz", 1, "g", "Kräutersalz")))).toBeNull()
})
it("does not turn soy sauce or stock cubes into table salt", async () => {
  for (const name of ["Sojasauce", "Brühwürfel"]) {
    vi.mocked(fetch).mockResolvedValue(response([hit(name, 50, 5)]))
    const result = await estimateRecipe(recipe([ingredient(name, 10)]))
    expect(result.matchedIngredients[0].source).toBe("OFF")
    expect(result.totals?.sodiumMg).toBe(500)
  }
})
it("keeps unknown density unresolved when LLM is unavailable", async () => {
  const result = await estimateRecipe(recipe([ingredient("UnknownPowder", 1, "EL")]))
  expect(result.unmatchedCount).toBe(1)
  expect(result.totals?.kcal).toBeNull()
})
it("recognizes implicit garlic clove quantities", async () => {
  const result = await estimateRecipe(recipe([ingredient("Knoblauchzehen", 2, null)]))
  expect(result.matchedIngredients[0].grams).toBe(6)
})
it("preserves explicit gram standards over density mappings", () => {
  const ing = ingredient("Mehl", 2, "EL")
  ing.unit!.standardQuantity = 9
  ing.unit!.standardUnit = "g"
  expect(convertToGrams(2, ing.unit, contextForName("Mehl"))).toBe(18)
  ing.unit!.standardQuantity = 15
  ing.unit!.standardUnit = "ml"
  expect(convertToGrams(2, ing.unit, contextForName("Mehl"))).toBeLessThan(18)
})
it("retains matched product provenance on cache hits", async () => {
  vi.mocked(fetch).mockResolvedValue(response([hit("Organic Basmati rice", 365)]))
  await lookupNutrients("Basmati-Reis")
  const cached = await lookupNutrients("Basmati-Reis")
  expect(cached.productName).toBe("Organic Basmati rice")
  expect(fetch).toHaveBeenCalledTimes(1)
})

describe("generic-first source priority", () => {
  it.each([
    ["Basmati-Reis", 100, 365],
    ["Wachtelbohnen", 500, 1735],
    ["Pintobohnen gekocht", 100, 143],
    ["Kidneybohnen", 100, 337],
    ["Kidneybohnen gekocht", 100, 127],
    ["Kidneybohnen aus der Dose", 100, 81],
    ["Kidneybohnen abgetropft", 100, 124],
    ["Reis gekocht", 100, 130],
    ["Olivenöl", 100, 884],
    ["Sonnenblumenöl", 100, 884],
    ["Butter", 100, 717],
    ["Zwiebel", 100, 40],
    ["Knoblauch", 100, 149],
    ["Kokosmilch", 100, 197],
  ])("uses the exact generic state profile for %s before any OFF request or cache", async (name, quantity, kcal) => {
    // Even a plausible, previously accepted OFF profile must not override the reference.
    const context = contextForName(name)
    const generic = genericNutrients(context)!
    cache.set(nutrientCacheKey("off", context), {
      nutrients: { ...generic, kcalPer100g: generic.kcalPer100g! * 1.1 },
      productName: name, confidence: "high",
    })
    vi.mocked(fetch).mockResolvedValue(response([hit(name, generic.kcalPer100g! * 1.1)]))
    const result = await estimateRecipe(recipe([ingredient(name, quantity)]))
    expect(result.matchedIngredients[0].source).toBe("generic")
    expect(result.matchedIngredients[0].reason).toContain("preferred before OFF")
    expect(result.totals?.kcal).toBe(kcal)
    expect(fetch).not.toHaveBeenCalled()
  })

  it("uses OFF for a specifically named branded packaged product", async () => {
    const name = "ExampleBrand Basmati rice cooked"
    vi.mocked(fetch).mockResolvedValue(response([
      hit("Basmati rice dry", 365),
      hit(name, 145, 0.3),
    ]))
    const result = await estimateRecipe(recipe([ingredient(name, 100)]))
    expect(result.matchedIngredients[0].source).toBe("OFF")
    expect(result.matchedIngredients[0].productName).toBe(name)
    expect(result.matchedIngredients[0].context?.state).toBe("cooked")
    expect(result.totals?.kcal).toBe(145)
    expect(result.totals?.sodiumMg).toBe(300)
    expect(fetch).toHaveBeenCalledOnce()
  })

  it("keeps a generic food unmatched when its state lacks a profile and LLM is disabled", async () => {
    vi.mocked(fetch).mockResolvedValue(response([hit("rice frozen", 140)]))
    const result = await estimateRecipe(recipe([ingredient("Reis tiefgekühlt", 100)]))
    expect(result.partial).toBe(true)
    expect(result.matchedIngredients[0].context?.state).toBe("frozen")
    expect(fetch).not.toHaveBeenCalled()
  })
})
