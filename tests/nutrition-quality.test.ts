import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest"
import { config } from "../src/config.js"
import { initCache } from "../src/utils/cache.js"
import { BUTTER_CHICKEN, KIDNEY_BEAN_CURRY, BIG_MAC_SALAD, RECIPE_FIXTURES } from "./helpers/nutrition-fixtures.js"
import { resolveIngredient, resolveRecipe, stubProviderResponses } from "./helpers/resolve-fixture.js"

/**
 * Behaviour-level regressions for the nutrition-quality problems found by manual recipe testing.
 * They assert PROVIDER CHOICE, SEMANTIC IDENTITY and arithmetic invariants rather than exact
 * calorie totals, because the totals move whenever a better database record wins — which is the
 * point of the change.
 *
 * The real bundled BLS database is used; OFF/USDA are served from recorded response shapes.
 */
beforeAll(async () => {
  config.cache.dbPath = `${config.cache.dbPath}`
  await initCache()
})

beforeEach(() => {
  config.usda.apiKey = "fixture-key"
  // Both backoffs, not just USDA's: the OFF default is 500 ms exponential over 3 retries, so every
  // deliberately-unresolved fixture ingredient slept 3.5 s against a stub that answers instantly.
  config.usda.retryBackoffMs = 1
  config.openFoodFacts.retryBackoffMs = 1
  config.llm.enabled = false
  config.llm.apiKey = ""
  vi.restoreAllMocks()
  stubProviderResponses()
})

const find = (rows: { ingredient: string }[], name: string) => rows.find((r) => r.ingredient === name)!

describe("BLS becomes reachable for ordinary German foods", () => {
  it("does not get WORSE when the correct coreFoodGerman is supplied", async () => {
    // The root cause: German qualifiers in BLS names ("roh", "Konserve") were scored as foreign
    // food content, so supplying the correct core dropped these below the fuzzy threshold.
    for (const name of ["Zwiebel", "Knoblauch", "Eisbergsalat"]) {
      const row = await resolveIngredient({
        name, canonicalGerman: name, canonicalEnglish: `${name}-english-no-match`,
        coreFoodGerman: name, coreFoodEnglish: `${name}-english-no-match`,
        grams: 100, state: "raw", foodType: "simple",
      })
      expect(row.provider, name).toBe("bls")
      expect(row.productName, name).toMatch(/roh/)
    }
  })

  it("reaches a chicken-breast record through German compound matching", async () => {
    const row = find((await resolveRecipe(BUTTER_CHICKEN)).rows, "Hähnchenbrust")
    expect(row.provider).toBe("bls")
    expect(row.productName).toMatch(/Hähnchen/)
    expect(row.productName).toMatch(/Brustfilet/)
    // a raw breast fillet is ~100-130 kcal/100 g; anything far outside means a wrong cut/state
    expect(row.kcalPer100g!).toBeGreaterThan(90)
    expect(row.kcalPer100g!).toBeLessThan(150)
  })

  it("reaches ground beef, cheddar and parmesan generically", async () => {
    const rows = (await resolveRecipe(BIG_MAC_SALAD)).rows
    expect(find(rows, "mageres Rinderhackfleisch").provider).toBe("bls")
    expect(find(rows, "Cheddar").provider).toBe("bls")
    expect(find(rows, "Parmesan").provider).toBe("bls")
  })
})

describe("nutritionally meaningful modifiers are respected", () => {
  it("generic Butter does not resolve to half-fat butter", async () => {
    const row = find((await resolveRecipe(BUTTER_CHICKEN)).rows, "Butter")
    expect(row.productName).not.toMatch(/Halbfett/i)
    // real butter is ~700-760 kcal/100 g; half-fat butter is ~377
    expect(row.kcalPer100g!).toBeGreaterThan(600)
  })

  it("fresh ginger does not resolve to ground dried ginger", async () => {
    const row = find((await resolveRecipe(BUTTER_CHICKEN)).rows, "Ingwer frisch")
    expect(row.preservation).toBe("fresh")
    expect(row.productName).not.toMatch(/ground|gemahlen|Pulver/i)
    expect(row.kcalPer100g!).toBeLessThan(120) // fresh root ~48; ground spice ~335
  })

  it("canned kidney beans keep their canned identity", async () => {
    const row = find((await resolveRecipe(KIDNEY_BEAN_CURRY)).rows, "Kidneybohnen a. d. Dose")
    expect(row.preservation).toBe("canned")
    expect(row.productName).toMatch(/Konserve/i)
    expect(row.kcalPer100g!).toBeLessThan(200) // dry beans would be ~316
  })

  it("explicitly ground cumin may still use a ground/seed spice record", async () => {
    const row = find((await resolveRecipe(BUTTER_CHICKEN)).rows, "Kreuzkümmel gemahlen")
    expect(row.form).toBe("ground")
    expect(row.provider).not.toBe("unresolved") // BLS has no cumin at all; USDA is correct here
  })

  it("keeps 7% and 15% cooking cream distinguishable and never silently upgrades to full fat", async () => {
    const base = {
      name: "Kochsahne", canonicalGerman: "Kochsahne", canonicalEnglish: "cooking cream",
      coreFoodGerman: "Sahne", coreFoodEnglish: "cream", grams: 200,
      state: "unknown" as const, foodType: "processed_single_food" as const,
    }
    const seven = await resolveIngredient({ ...base, name: "Kochsahne 7%", attributes: { fatPercent: 7 } })
    const fifteen = await resolveIngredient({ ...base, name: "Kochsahne 15%", attributes: { fatPercent: 15 } })
    expect(seven.fatPercent).toBe(7)
    expect(fifteen.fatPercent).toBe(15)
    // Neither may silently become a 30%+ whipping cream (~300+ kcal/100 g).
    for (const r of [seven, fifteen]) {
      if (r.kcalPer100g !== null) expect(r.kcalPer100g).toBeLessThan(250)
    }
  })
})

describe("generic foods are not routed to arbitrary branded products", () => {
  it("prefers a generic record over a branded OFF product for basic foods", async () => {
    const curry = (await resolveRecipe(KIDNEY_BEAN_CURRY)).rows
    const salad = (await resolveRecipe(BIG_MAC_SALAD)).rows
    // OFF fixtures deliberately offer branded Tilda rice / Publix beef / Kroger lettuce.
    for (const row of [find(curry, "Basmati-Reis"), find(salad, "mageres Rinderhackfleisch"), find(salad, "Eisbergsalat")]) {
      expect(row.provider, row.ingredient).not.toBe("off")
    }
  })

  it("still allows OFF when the ingredient carries explicit brand evidence", async () => {
    const row = await resolveIngredient({
      name: "Barilla Pasta", canonicalGerman: "Pasta", canonicalEnglish: "pasta",
      coreFoodGerman: "Pasta", coreFoodEnglish: "pasta", grams: 100,
      state: "unknown", foodType: "processed_single_food", brand: "Barilla",
    })
    expect(row.provider).toBe("off")
  })
})

describe("recipe-level arithmetic invariants", () => {
  it("every fixture divides by servings exactly once and stays internally consistent", async () => {
    for (const fixture of RECIPE_FIXTURES) {
      const { rows, total, perServing } = await resolveRecipe(fixture)
      const summed = rows.reduce((a, r) => a + r.kcalContribution, 0)
      expect(total, fixture.name).toBeCloseTo(summed, 6)
      expect(perServing, fixture.name).toBeCloseTo(total / fixture.servings, 6)
      for (const r of rows) {
        if (r.kcalPer100g !== null) {
          expect(r.kcalContribution, `${fixture.name}/${r.ingredient}`)
            .toBeCloseTo((r.kcalPer100g * r.grams) / 100, 6)
        }
      }
    }
  })

  it("resolves the great majority of each fixture from an authoritative database", async () => {
    for (const fixture of RECIPE_FIXTURES) {
      const { rows } = await resolveRecipe(fixture)
      const db = rows.filter((r) => r.provider === "bls" || r.provider === "usda").length
      expect(db / rows.length, fixture.name).toBeGreaterThanOrEqual(0.75)
    }
  })

  it("keeps the coconut-milk contribution that legitimately makes the curry dense", async () => {
    // Investigated and confirmed correct: BLS H154000 is full-fat coconut milk at 227 kcal/100 g,
    // so 200 g really is ~454 kcal. The curry being calorie-dense is arithmetic, not a bug.
    const row = find((await resolveRecipe(KIDNEY_BEAN_CURRY)).rows, "Kokosmilch")
    expect(row.provider).toBe("bls")
    expect(row.kcalContribution).toBeGreaterThan(400)
    expect(row.kcalContribution).toBeLessThan(500)
  })
})
