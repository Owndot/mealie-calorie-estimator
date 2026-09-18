import { vi } from "vitest"
import { config } from "../../src/config.js"
import { resolveNutrients } from "../../src/services/nutrient-resolver.js"
import { attributesOf, OFF_HITS, USDA_HITS, type FixtureIngredient, type RecipeFixture } from "./nutrition-fixtures.js"

export interface ResolvedRow {
  ingredient: string
  form: string
  preservation: string
  fatPercent: number | null
  provider: string
  productName: string | null
  providerId: string | null
  grams: number
  kcalPer100g: number | null
  kcalContribution: number
  confidence: number | null
}

/** Routes the single global fetch to the recorded OFF/USDA shapes; anything unknown returns no hits. */
export function stubProviderResponses(): void {
  vi.stubGlobal("fetch", vi.fn(async (url: any) => {
    const u = String(url)
    if (u.startsWith(config.openFoodFacts.searchBaseUrl)) {
      const q = decodeURIComponent(new URL(u).searchParams.get("q") ?? "").toLowerCase()
      return new Response(JSON.stringify({ hits: OFF_HITS[q] ?? [] }), { status: 200, headers: { "content-type": "application/json" } })
    }
    // No remote-USDA branch: usda-local reads a bundled SQLite database and makes no
    // HTTP request, so there is nothing to stub. USDA_HITS below serves the OFF-shaped fixtures.
    return new Response("{}", { status: 200 })
  }))
}

export async function resolveIngredient(i: FixtureIngredient): Promise<ResolvedRow> {
  const attrs = attributesOf(i)
  const resolved = await resolveNutrients(
    {
      foodName: i.canonicalEnglish, structuredName: i.name, canonicalGerman: i.canonicalGerman,
      brand: i.brand ?? null, category: i.category ?? null, state: i.state, foodType: i.foodType,
      coreFoodGerman: i.coreFoodGerman, coreFoodEnglish: i.coreFoodEnglish,
      route: i.brand ? "branded" : "generic",
      attributes: attrs,
      evidence: { german: true, english: true, core: true, brand: Boolean(i.brand) },
    } as never,
    i.brand ? "branded" : "generic",
  )
  const kcal100 = resolved?.match.nutrients.kcalPer100g ?? null
  return {
    ingredient: i.name,
    form: attrs.form,
    preservation: attrs.preservation,
    fatPercent: attrs.fatPercent,
    provider: resolved?.fallbackStatus ?? "unresolved",
    productName: resolved?.match.productName ?? null,
    providerId: resolved?.match.providerId ?? null,
    grams: i.grams,
    kcalPer100g: kcal100,
    kcalContribution: kcal100 === null ? 0 : (kcal100 * i.grams) / 100,
    confidence: resolved?.match.confidence ?? null,
  }
}

export async function resolveRecipe(fixture: RecipeFixture): Promise<{ rows: ResolvedRow[]; total: number; perServing: number }> {
  const rows: ResolvedRow[] = []
  for (const i of fixture.ingredients) rows.push(await resolveIngredient(i))
  const total = rows.reduce((a, r) => a + r.kcalContribution, 0)
  return { rows, total, perServing: total / fixture.servings }
}

export function formatTable(rows: ResolvedRow[]): string {
  const head = `${"ingredient".padEnd(24)}${"form/presv".padEnd(18)}${"provider".padEnd(14)}${"record".padEnd(38)}${"g".padStart(5)}${"kcal/100".padStart(9)}${"kcal".padStart(8)}${"conf".padStart(7)}`
  const body = rows.map((r) =>
    `${r.ingredient.slice(0, 23).padEnd(24)}` +
    `${`${r.form}/${r.preservation}${r.fatPercent !== null ? ` ${r.fatPercent}%` : ""}`.slice(0, 17).padEnd(18)}` +
    `${r.provider.padEnd(14)}` +
    `${(r.productName ?? "—").slice(0, 37).padEnd(38)}` +
    `${String(r.grams).padStart(5)}${String(r.kcalPer100g ?? "—").padStart(9)}${r.kcalContribution.toFixed(0).padStart(8)}${String(r.confidence ?? "—").padStart(7)}`)
  return [head, "-".repeat(head.length), ...body].join("\n")
}
