import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest"
import { config } from "../src/config.js"
import { initCache } from "../src/utils/cache.js"
import { recipe, runPipeline, row, formatRows, type E2EResult, type E2ERow } from "./helpers/e2e-pipeline.js"
import { __resetRecipeIndexForTests } from "../src/services/providers/mealie-recipe-provider.js"
import {
  KIDNEY_CURRY, TIKKA_PASTE, BUTTER_CHICKEN, BIG_MAC_SALAT, TIKKA_PASTE_RECIPE, replayProductionRerank,
  type ProductionRecipe,
} from "./helpers/production-fixtures.js"
import type { MealieRecipe } from "../src/types.js"
import recordedUsdaPages from "./fixtures/usda-recorded-pages.json"

/**
 * The four acceptance recipes, end to end, from fixtures transcribed from the LIVE Mealie instance.
 *
 * An earlier version of this file carried only a SUBSET of each recipe — 7 of the Big-Mac-Salat's
 * 16 ingredients, 5 of Butter Chicken's 15 — which made its totals silently incomparable with
 * production's. A before/after quoted across that gap looked like a far bigger improvement than the
 * change actually produced. Every ingredient is now present with production's own grams, and each
 * recipe asserts it reproduces production's per-ingredient PROVIDER and RECORD, which is what makes
 * the totals mean anything.
 */
const served: Record<string, MealieRecipe> = {}
vi.mock("../src/services/mealie-client.js", () => ({
  listRecipeNames: vi.fn(async () => Object.values(served).map((r) => ({ slug: r.slug, name: r.name }))),
  getRecipe: vi.fn(async (slug: string) => {
    if (!served[slug]) throw new Error(`404 ${slug}`)
    return served[slug]
  }),
  getRecipeHouseholdId: vi.fn(() => null),
  patchRecipe: vi.fn(async () => {}),
  getOrCreateTags: vi.fn(async () => []),
  getAllRecipes: vi.fn(async () => Object.keys(served)),
}))

beforeAll(async () => {
  await initCache()
})

beforeEach(() => {
  config.usda.retryBackoffMs = 1
  config.openFoodFacts.retryBackoffMs = 1
  config.mealieRecipeSource.enabled = true
  for (const k of Object.keys(served)) delete served[k]
  __resetRecipeIndexForTests()
})

afterEach(() => {
  config.llm.enabled = false
  config.llm.apiKey = ""
})

/**
 * The USDA pages these recipes hit, recorded from the live FoodData Central API (pageSize=25, the
 * production request) and trimmed to the fields the provider reads.
 *
 * An earlier version of this map was hand-written from memory and described as recorded. It held
 * two candidates for "red chili peppers" where the live page holds twenty-three, and gave "Peppers,
 * sweet, red, raw" the 31 kcal of the FNDDS record while carrying the SR Legacy id — a record that
 * does not exist. That is not a fixture, it is an assumption with a citation, and it changed the
 * outcome: the truncated candidate set made USDA rerank the chilli, where production did not.
 *
 * `Branded` rows are omitted because every ingredient in these four recipes has brand null, so the
 * provider takes the generic route and discards Branded before ranking (usda-provider.ts). A query
 * absent from this map answers with an empty page, which is how production's outcome is reproduced
 * for the ingredients no USDA record satisfied.
 */
const USDA = recordedUsdaPages as Record<string, unknown[]>

async function run(fixture: ProductionRecipe): Promise<E2EResult> {
  return runPipeline(recipe(fixture.slug, fixture.servings, fixture.ingredients), {
    classifications: fixture.classifications,
    llmGrams: fixture.llmGrams,
    llmNutrients: fixture.llmNutrients,
    usda: USDA,
    // Production's OWN recorded verdicts, replayed. A stub with a fixed answer models a broken
    // judge, not this one: always-accept put "rote Chilischoten" on BLS's sweet-pepper record, and
    // always-decline lost the Ketchup, Pfeffer and Wasser that production resolved. Adversarial
    // stubs belong in the targeted safety tests, where the assertion is that the gates hold anyway.
    rerank: replayProductionRerank,
  })
}

/** Prints the table the reconciliation is read from. */
function report(label: string, r: E2EResult, servings: number, productionTotal: number): void {
  // eslint-disable-next-line no-console
  console.log(
    `\n=== ${label} — ${r.totalKcal.toFixed(1)} kcal total, ${Math.round(r.totalKcal / servings)} kcal/serving ` +
    `(production recorded ${productionTotal}, ${Math.round(productionTotal / servings)}/serving) — ${r.matchQuality} ===\n${formatRows(r)}`)
}

/**
 * Asserts the run reproduces production's recorded provenance ROW BY ROW: same ingredient order,
 * same provider, same record, same grams, same confidence.
 *
 * Without this a matching total would prove nothing — offsetting errors across sixteen ingredients
 * land on the same number all the time, and the subset fixtures these replaced did exactly that.
 *
 * Two kinds of exception, both explicit and both still pinned to a value:
 *   - `fixture.fixtureDeviations` — cells the replay cannot reproduce, each carrying its reason.
 *   - `changedByThisPr` — cells this branch is MEANT to change, named at the call site.
 */
function expectReproducesProduction(r: E2EResult, fixture: ProductionRecipe, changedByThisPr: string[] = []): void {
  expect(r.rows.map((x) => x.ingredient)).toEqual(fixture.productionRows.map(([name]) => name))
  for (const [name, provider, productName, grams, confidence] of fixture.productionRows) {
    if (changedByThisPr.includes(name)) continue
    const deviation = fixture.fixtureDeviations?.[name]
    const actual = row(r, name)
    expect([actual.provider, actual.productName, actual.grams, actual.confidence], name).toEqual([
      deviation?.provider ?? provider,
      deviation && "record" in deviation ? deviation.record ?? null : productName,
      grams,
      deviation?.confidence ?? confidence,
    ])
  }
}

describe("Kidney-Bohnen-Tomaten-Curry", () => {
  it("reproduces production's records", async () => {
    const r = await run(KIDNEY_CURRY)
    report("Kidney curry", r, KIDNEY_CURRY.servings, KIDNEY_CURRY.productionTotalKcal)
    expectReproducesProduction(r, KIDNEY_CURRY)

    const beans = row(r, "Kidneybohnen a. d. Dose")
    expect(beans.provider).toBe("bls")
    expect(beans.providerId).toBe("H742902")
    expect(beans.productName).toMatch(/Konserve, abgetropft/)
    expect(beans.confidence).toBe(0.85)
    expect(beans.kcalContribution).toBeCloseTo(512, 0)

    expect(row(r, "Basmati-Reis").productName).toMatch(/Reis poliert/)
    expect(row(r, "Kokosmilch").productName).toMatch(/Kokosmilch/)
    expect(row(r, "Koriander").productName ?? "").not.toMatch(/seed|samen/i)
  })
})

describe("Tikka-Paste (the source recipe)", () => {
  it("reproduces production's records and the per-100 g its consumer uses", async () => {
    const r = await run(TIKKA_PASTE)
    report("Tikka-Paste", r, TIKKA_PASTE.servings, TIKKA_PASTE.productionTotalKcal)
    expectReproducesProduction(r, TIKKA_PASTE)

    expect(row(r, "Röstzwiebel").productName).toMatch(/Röstzwiebeln/)
    expect(row(r, "Röstzwiebel").productName).not.toMatch(/Speisezwiebel/)
    expect(row(r, "rote Chilischoten").productName).toMatch(/hot chili/)
    expect(row(r, "rote Chilischoten").productName).not.toMatch(/sweet/)

    // 800 g yield: this is the number the consumer divides by.
    expect((TIKKA_PASTE.productionTotalKcal / TIKKA_PASTE.yieldQuantity!) * 100).toBeCloseTo(359.085, 2)
  })
})

describe("Butter Chicken (the homemade-ingredient consumer)", () => {
  it("reproduces production's records, including the homemade paste", async () => {
    served[TIKKA_PASTE_RECIPE.slug] = TIKKA_PASTE_RECIPE
    const r = await run(BUTTER_CHICKEN)
    report("Butter Chicken", r, BUTTER_CHICKEN.servings, BUTTER_CHICKEN.productionTotalKcal)
    expectReproducesProduction(r, BUTTER_CHICKEN)

    const paste = row(r, "Tikka-Paste")
    expect(paste.provider).toBe("mealie-recipe")
    expect(paste.providerId).toBe("tikka-paste")
    expect(paste.matchReason).toBe("exact-recipe-name")
    expect(paste.grams).toBe(100)
    expect(paste.kcalPer100g!).toBeCloseTo(359.085, 1)
    expect(paste.kcalContribution).toBeCloseTo(359.085, 1)

    expect(row(r, "Ghee").productName).toMatch(/Butterschmalz/)
    expect(row(r, "Hähnchenbrust").productName).toMatch(/Brustfilet/)

    // The explicit percentage survives the whole pipeline and is never substituted.
    const cream = row(r, "Kochsahne 15%")
    expect(cream.requestedFatPercent).toBe(15)
    expect(cream.productName ?? "").not.toMatch(/Schlagsahne|Schmand|Sauerrahm|30 %|36 %/)
  })
})

describe("Big-Mac-Salat", () => {
  it("reproduces production's records, and moves exactly one ingredient", async () => {
    const r = await run(BIG_MAC_SALAT)
    report("Big-Mac-Salat", r, BIG_MAC_SALAT.servings, BIG_MAC_SALAT.productionTotalKcal)

    // Fifteen of sixteen ingredients are byte-identical to production, including the ones the
    // no-regress list names: Senf stays mittelscharf, Gurkenwasser never becomes cucumber juice,
    // Nudeln stays generic pasta, Knoblauchgewürz stays garlic powder.
    expectReproducesProduction(r, BIG_MAC_SALAT, ["Mayo Light"])

    // THE ONE MOVE. BLS's "Salatmayonnaise (Fertigprodukt)" is 490 kcal and does not satisfy the
    // stated "light"; USDA holds a real "Mayonnaise, light" at 238. Identity is equally good in
    // both records, so only the attribute separates them — which is the whole change.
    const mayo = row(r, "Mayo Light")
    expect(mayo.provider).toBe("usda")
    expect(mayo.productName).toMatch(/light/i)
    expect(mayo.unmetAttributes).toEqual([])
    expect(mayo.confidence!).toBeGreaterThan(0.55)

    // The beef does NOT move, and that is the correct outcome for this data: BLS's mince is the
    // right food but is not lean, USDA's ground-beef family is FATTIER still, and production
    // recorded no LLM estimate to fall back on. Attribute-aware routing walked the whole chain,
    // found nothing better, and kept the flagged record — visibly flagged, not silently used.
    const beef = row(r, "mageres Rinderhackfleisch")
    expect(beef.provider).toBe("bls")
    expect(beef.unmetAttributes).toEqual(["reduced-fat"])
    expect(beef.confidence!).toBeLessThanOrEqual(0.55)
    // Never "fixed" by swapping in a different product that happens to be leaner.
    expect(beef.productName ?? "").not.toMatch(/Tatar|Schabefleisch/)
    expect(r.matchQualityReason).toMatch(/mageres Rinderhackfleisch/)
    expect(r.matchQualityReason).toMatch(/does not satisfy the explicit reduced-fat attribute/)
  })

  it("accounts for the whole difference from production in that one ingredient", async () => {
    const r = await run(BIG_MAC_SALAT)
    // Production recorded 12 g of BLS "Salatmayonnaise (Fertigprodukt)" at 490 kcal/100 g = 58.8.
    // This branch resolves 12 g of USDA "Mayonnaise, light" at 238 kcal/100 g = 28.56.
    // Every other row is identical, so the whole-recipe difference IS that one subtraction —
    // which is the check that the total moved for the stated reason and not for some other one.
    const mayo = row(r, "Mayo Light")
    expect(mayo.kcalPer100g).toBe(238)
    expect(mayo.kcalContribution).toBeCloseTo(28.56, 6)
    expect(BIG_MAC_SALAT.productionTotalKcal - r.totalKcal).toBeCloseTo(58.8 - 28.56, 6)
    // 851 -> 841 kcal/serving over 3 servings.
    expect(r.perServingKcal).toBe(841)
  })
})

/**
 * The cases earlier production failures were traced to, named one by one so the list is legible
 * and greppable rather than implied by a row-by-row diff. `expectReproducesProduction` above
 * already pins every one of these to an exact record; this states WHY each is pinned, so a future
 * change that breaks one gets a sentence explaining what it broke instead of a tuple mismatch.
 */
describe("none of the earlier production failures come back", () => {
  const cases: [ProductionRecipe, string, (r: E2ERow) => void][] = [
    [KIDNEY_CURRY, "Kidneybohnen a. d. Dose", (x) => {
      // Resolved to USDA's prepared "Kidney beans, NFS" (708 kcal) once, overstating by ~196 kcal.
      expect(x.provider).toBe("bls"); expect(x.providerId).toBe("H742902")
    }],
    [KIDNEY_CURRY, "Koriander", (x) => {
      // The herb, not the seed — a plant-part swap worth 23 vs 298 kcal/100 g.
      expect(x.productName ?? "").not.toMatch(/seed|samen|körner/i)
    }],
    [TIKKA_PASTE, "Röstzwiebel", (x) => {
      // Fried onions (575) must not flatten to raw Speisezwiebel (34).
      expect(x.productName).toMatch(/Röstzwiebeln/); expect(x.productName).not.toMatch(/Speisezwiebel/)
    }],
    [TIKKA_PASTE, "rote Chilischoten", (x) => {
      // Hot chilli, never sweet bell pepper — a different vegetable, not a milder one.
      expect(x.productName).toMatch(/hot chili/); expect(x.productName).not.toMatch(/sweet/)
    }],
    [BUTTER_CHICKEN, "Tikka-Paste", (x) => {
      // The user's own recipe (359 kcal/100 g), not an LLM guess at ~100.
      expect(x.provider).toBe("mealie-recipe"); expect(x.providerId).toBe("tikka-paste")
    }],
    [BUTTER_CHICKEN, "Ghee", (x) => expect(x.productName).toMatch(/Butterschmalz/)],
    [BUTTER_CHICKEN, "Kochsahne 15%", (x) => {
      // The stated percentage survives, and no neighbouring cream is substituted for it.
      expect(x.requestedFatPercent).toBe(15)
      expect(x.productName ?? "").not.toMatch(/Schlagsahne|Schmand|Sauerrahm|Kaffeesahne|30 %|36 %/)
    }],
    [BIG_MAC_SALAT, "Gurkenwasser", (x) => {
      // Pickle brine is not cucumber juice and not cucumber; being made from one is not enough.
      expect(x.productName ?? "").not.toMatch(/saft|juice|Gurke roh/i)
    }],
    [BIG_MAC_SALAT, "Senf", (x) => {
      // Medium mustard must not drift to "scharf", which is a different product.
      expect(x.productName).toBe("Senf mittelscharf")
    }],
    [BIG_MAC_SALAT, "Nudeln", (x) => {
      // Generic pasta, not a filled or flavoured variety.
      expect(x.productName).toBe("Teigwaren eifrei, roh")
    }],
    [BIG_MAC_SALAT, "Knoblauchgewürz", (x) => {
      // Garlic powder (331), not raw garlic (143) and not a seasoning blend.
      expect(x.productName).toMatch(/garlic powder/)
    }],
    [BIG_MAC_SALAT, "Ketchup", (x) => expect(x.productName).toMatch(/[Kk]etchup/)],
    [BIG_MAC_SALAT, "Mayo Light", (x) => {
      // Case B: the light claim is satisfied, not merely recorded as unmet.
      expect(x.productName).toMatch(/light/i); expect(x.unmetAttributes).toEqual([])
    }],
    [BIG_MAC_SALAT, "mageres Rinderhackfleisch", (x) => {
      // Case A: never silently generic-fat, and never "fixed" by substituting Tatar.
      expect(x.unmetAttributes).toEqual(["reduced-fat"])
      expect(x.productName ?? "").not.toMatch(/Tatar|Schabefleisch/)
    }],
  ]

  const byRecipe = new Map<ProductionRecipe, [string, (r: E2ERow) => void][]>()
  for (const [fixture, name, check] of cases) {
    byRecipe.set(fixture, [...(byRecipe.get(fixture) ?? []), [name, check]])
  }

  for (const [fixture, checks] of byRecipe) {
    it(`${fixture.slug}: ${checks.map(([n]) => n).join(", ")}`, async () => {
      served[TIKKA_PASTE_RECIPE.slug] = TIKKA_PASTE_RECIPE
      __resetRecipeIndexForTests()
      const r = await run(fixture)
      for (const [name, check] of checks) check(row(r, name))
    })
  }
})

describe("recipe arithmetic holds for every acceptance recipe", () => {
  it("sums contributions exactly and divides by servings exactly once", async () => {
    for (const fixture of [KIDNEY_CURRY, TIKKA_PASTE, BIG_MAC_SALAT]) {
      const r = await run(fixture)
      const summed = r.rows.reduce((a, x) => a + x.kcalContribution, 0)
      expect(r.totalKcal, fixture.slug).toBeCloseTo(summed, 6)
      expect(r.perServingKcal, fixture.slug).toBeCloseTo(Math.round(r.totalKcal / fixture.servings), 0)
    }
  })

  it("lands within each fixture's declared distance of production's recorded total", async () => {
    // Pins the modelling error itself. A fixture drifting away from production is the failure this
    // whole file exists to catch, and a tolerance that is never asserted is not a tolerance.
    // Big-Mac-Salat is excluded because this branch deliberately moves its total; its own describe
    // checks that the move is exactly the mayonnaise row and nothing else.
    served[TIKKA_PASTE_RECIPE.slug] = TIKKA_PASTE_RECIPE
    for (const fixture of [KIDNEY_CURRY, TIKKA_PASTE, BUTTER_CHICKEN]) {
      // The name index is built once per process and cached; without this the second and third
      // runs reuse whatever the first one saw.
      __resetRecipeIndexForTests()
      const r = await run(fixture)
      expect(Math.abs(r.totalKcal - fixture.productionTotalKcal), fixture.slug)
        .toBeLessThanOrEqual(fixture.reconcilesWithin)
    }
  })
})
