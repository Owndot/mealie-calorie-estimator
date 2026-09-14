import { vi } from "vitest"

export interface UsdaTestProfile {
  kcal: number
  protein?: number
  carbs?: number
  fat?: number
  satFat?: number
  transFat?: number
  fiber?: number
  sugar?: number
  /** milligrams, as USDA reports it — converted to internal grams by the real provider code. */
  sodiumMg?: number
  cholesterolMg?: number
}

let nextFdcId = 1

function toFdcFoodNutrients(p: UsdaTestProfile) {
  const nutrients: { nutrientId: number; nutrientName: string; unitName: string; value: number }[] = [
    { nutrientId: 1008, nutrientName: "Energy", unitName: "KCAL", value: p.kcal },
  ]
  if (p.protein != null) nutrients.push({ nutrientId: 1003, nutrientName: "Protein", unitName: "G", value: p.protein })
  if (p.carbs != null) nutrients.push({ nutrientId: 1005, nutrientName: "Carbohydrate, by difference", unitName: "G", value: p.carbs })
  if (p.fat != null) nutrients.push({ nutrientId: 1004, nutrientName: "Total lipid (fat)", unitName: "G", value: p.fat })
  if (p.satFat != null) nutrients.push({ nutrientId: 1258, nutrientName: "Fatty acids, total saturated", unitName: "G", value: p.satFat })
  if (p.transFat != null) nutrients.push({ nutrientId: 1257, nutrientName: "Fatty acids, total trans", unitName: "G", value: p.transFat })
  if (p.fiber != null) nutrients.push({ nutrientId: 1079, nutrientName: "Fiber, total dietary", unitName: "G", value: p.fiber })
  if (p.sugar != null) nutrients.push({ nutrientId: 2000, nutrientName: "Sugars, total", unitName: "G", value: p.sugar })
  if (p.sodiumMg != null) nutrients.push({ nutrientId: 1093, nutrientName: "Sodium, Na", unitName: "MG", value: p.sodiumMg })
  if (p.cholesterolMg != null) nutrients.push({ nutrientId: 1253, nutrientName: "Cholesterol", unitName: "MG", value: p.cholesterolMg })
  return nutrients
}

/**
 * Mocks global fetch to answer USDA FoodData Central search requests from a food-name-keyed
 * profile map (case-insensitive exact match on the structured food name, since these tests run
 * with the LLM disabled and canonical name = the raw structured food.name). Any other host
 * (e.g. Open Food Facts) or unmapped food returns an empty result — proving the generic route
 * never reaches OFF and that unmapped foods resolve to nothing rather than a fabricated value.
 */
export function mockUsdaProvider(profiles: Record<string, UsdaTestProfile>): void {
  const byLowerName = new Map(Object.entries(profiles).map(([name, p]) => [name.toLowerCase(), p]))

  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
    const url = new URL(String(input))

    if (!url.hostname.includes("nal.usda.gov")) {
      return new Response(JSON.stringify({ hits: [] }), { status: 200, headers: { "content-type": "application/json" } })
    }

    const query = url.searchParams.get("query") ?? ""
    const profile = byLowerName.get(query.toLowerCase())

    if (!profile) {
      return new Response(JSON.stringify({ foods: [] }), { status: 200, headers: { "content-type": "application/json" } })
    }

    return new Response(
      JSON.stringify({
        foods: [{ description: query, fdcId: nextFdcId++, foodNutrients: toFdcFoodNutrients(profile) }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  })
}
