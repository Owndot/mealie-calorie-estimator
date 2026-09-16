import { vi } from "vitest"
import { useUsdaLocalFixture, type UsdaTestFood } from "./usda-local-fixture.js"

export interface UsdaTestProfile {
  kcal: number
  protein?: number
  carbs?: number
  fat?: number
  satFat?: number
  transFat?: number
  fiber?: number
  sugar?: number
  /** MILLIGRAMS, as USDA's source files report it — converted to internal grams here, exactly as
   *  scripts/import_usda.py does when building the real database. */
  sodiumMg?: number
  cholesterolMg?: number
}

let nextFdcId = 1

/**
 * Gives these tests a USDA corpus containing exactly `profiles`, keyed by food name.
 *
 * This used to stub `fetch` to answer FoodData Central search requests. There is no request to
 * stub any more — USDA is a bundled local database — so the seam moved down a layer: the profiles
 * become a real (temporary) database and the provider runs its genuine load, retrieval, ranking
 * and gating over it. The observable contract is unchanged: a named food resolves through USDA, an
 * unnamed one resolves to nothing rather than a fabricated value.
 *
 * `fetch` is still stubbed, for Open Food Facts only — these tests assert the generic route never
 * needs OFF, and an empty hit list is what proves it.
 */
export async function mockUsdaProvider(profiles: Record<string, UsdaTestProfile>): Promise<void> {
  const foods: UsdaTestFood[] = Object.entries(profiles).map(([description, p]) => ({
    fdcId: nextFdcId++,
    description,
    dataType: "Foundation",
    kcal: p.kcal,
    protein: p.protein,
    carbs: p.carbs,
    fat: p.fat,
    saturatedFat: p.satFat,
    transFat: p.transFat,
    fiber: p.fiber,
    sugar: p.sugar,
    sodium: p.sodiumMg == null ? undefined : p.sodiumMg / 1000,
    cholesterol: p.cholesterolMg == null ? undefined : p.cholesterolMg / 1000,
  }))
  await useUsdaLocalFixture(foods)

  vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    new Response(JSON.stringify({ hits: [] }), { status: 200, headers: { "content-type": "application/json" } }))
}
