import { config } from "../config.js"
import { inferStateFromName } from "../services/providers/ranking.js"
import { inferAttributesFromName } from "../services/providers/food-semantics.js"
import type { JudgeCandidate } from "../services/providers/judge/types.js"
import type { FoodAttributes } from "../types.js"

/**
 * BENCHMARK ONLY — Open Food Facts as a VERIFIED PROXY, never as a general database.
 *
 * A branded retail product is worth consulting for exactly one thing: a property the generic
 * composition databases cannot express. "Kochsahne 7 %" is a formulated retail variant and BLS has
 * no such record; "Rinderhack 10 % Fett" is a grade USDA files directly, so OFF adds nothing but
 * noise and a network round trip. That distinction is the routing rule below, and it is decided by
 * the LOCAL pool, not by the food.
 */

const tokens = (s: string): string[] =>
  s.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").replace(/[^a-z0-9]+/g, " ").split(/\s+/).filter(Boolean)

const num = (v: unknown): number | null =>
  (typeof v === "number" && Number.isFinite(v) ? Math.round(v * 100) / 100 : null)

/**
 * Categories that are never a generic ingredient proxy, however well the NAME matches. Measured
 * against live OFF: a "Mayonnaise Light" search returns a soy drink, a bacon sauce and a raspberry
 * syrup whose BRAND is "Light"; a "Kochsahne 15%" search returns baby-food purées because
 * "15 months" contains "15".
 */
const EXCLUDED_CATEGORY_TAGS = [
  "en:baby-foods", "en:baby-milks", "en:meals", "en:prepared-meals", "en:pizzas", "en:sandwiches",
  "en:desserts", "en:snacks", "en:beverages", "en:sodas", "en:waters", "en:syrups", "en:candies",
  "en:breakfast-cereals", "en:biscuits-and-cakes", "en:plant-based-foods-and-beverages",
]

export interface OffHit {
  code?: string
  product_name?: string
  brands?: string[] | string
  categories_tags?: string[]
  nutriments?: Record<string, number | undefined>
}

export interface OffFilterResult {
  kept: JudgeCandidate[]
  /** Why each rejected hit was rejected, counted — the filter's own audit trail. */
  dropped: Record<string, number>
  rawHits: number
}

/** Live OFF search. Never logs headers or credentials; OFF needs no key. */
export async function searchOff(query: string, pageSize = 20): Promise<OffHit[]> {
  const params = new URLSearchParams({
    q: query,
    langs: config.openFoodFacts.language,
    page_size: String(pageSize),
    fields: "code,product_name,brands,categories_tags,nutriments",
  })
  try {
    const res = await fetch(`${config.openFoodFacts.searchBaseUrl}/search?${params}`)
    if (!res.ok) return []
    return ((await res.json()) as { hits?: OffHit[] }).hits ?? []
  } catch {
    return []
  }
}

/**
 * Four evidence-based filters, none of them food-specific:
 *   1. it must report energy — more than half of live retail hits carry no nutriments at all;
 *   2. the query's core food token must appear in the product NAME, so a brand called "Light"
 *      cannot answer a query for light mayonnaise;
 *   3. its category must not be an excluded class;
 *   4. when the query states a percentage, the product's MEASURED fat must match it within
 *      tolerance — this is what keeps 12-15% Kochsahne out of a 7% query.
 */
export function filterOffHits(
  hits: OffHit[],
  coreTexts: (string | null)[],
  attributes: FoodAttributes,
): OffFilterResult {
  const core = coreTexts.flatMap((t) => tokens(t ?? "")).filter((t) => t.length > 3)
  const wantFat = attributes.fatPercent
  const dropped: Record<string, number> = {}
  const drop = (why: string) => { dropped[why] = (dropped[why] ?? 0) + 1 }

  const kept: JudgeCandidate[] = []
  for (const h of hits) {
    const n = h.nutriments ?? {}
    const kcal = num(n["energy-kcal_100g"])
    if (kcal === null) { drop("no energy reported"); continue }

    const name = (h.product_name ?? "").trim()
    if (!name) { drop("no product name"); continue }
    const nameTokens = tokens(name)
    if (core.length > 0 && !core.some((c) => nameTokens.some((t) => t.includes(c) || c.includes(t)))) {
      drop("core food absent from the product NAME")
      continue
    }

    const cats = h.categories_tags ?? []
    if (cats.some((c) => EXCLUDED_CATEGORY_TAGS.includes(c))) { drop("excluded product category"); continue }

    const fat = num(n.fat_100g)
    if (wantFat != null) {
      if (fat === null) { drop("no measured fat for a numeric query"); continue }
      if (Math.abs(fat - wantFat) > Math.max(2, wantFat * 0.15)) { drop(`measured fat outside tolerance of ${wantFat}%`); continue }
    }

    const attrs = inferAttributesFromName(name)
    kept.push({
      id: `off:${h.code ?? name}`,
      provider: "off",
      providerId: String(h.code ?? name),
      name,
      dataType: "OFF product",
      brand: Array.isArray(h.brands) ? h.brands.join("/") : (h.brands ?? null),
      category: cats.filter((c) => c.startsWith("en:")).slice(-2).join(",") || null,
      state: inferStateFromName(name),
      form: attrs.form,
      preservation: attrs.preservation,
      nutrients: {
        kcalPer100g: kcal,
        proteinPer100g: num(n.proteins_100g),
        carbsPer100g: num(n.carbohydrates_100g),
        fatPer100g: fat,
        saturatedFatPer100g: num(n["saturated-fat_100g"]),
        transFatPer100g: null,
        unsaturatedFatPer100g: null,
        fiberPer100g: num(n.fiber_100g),
        sugarPer100g: num(n.sugars_100g),
        sodiumPer100g: num(n.sodium_100g),
        cholesterolPer100g: null,
      },
      // OFF products carry no deterministic rank of their own; they sort after the scored records
      // and are distinguished from each other by the ordering's later keys.
      score: 0,
    })
  }
  return { kept, dropped, rawHits: hits.length }
}

/**
 * Is an OFF proxy JUSTIFIED for this ingredient?
 *
 * Only when the LOCAL databases cannot already express the requested property. Decided by looking
 * at what the local pool actually contains, so it needs no list of foods: an explicit "10 % fat"
 * finds a USDA grade that states it and OFF is skipped, while a qualitative "mager" finds nothing
 * that states leanness and the retail label becomes the only available evidence.
 */
export function offProxyJustified(
  localPropertyBearing: JudgeCandidate[],
  propertyKind: string,
): { justified: boolean; why: string } {
  if (propertyKind === "none") {
    return { justified: false, why: "no unresolved property — OFF adds nothing" }
  }
  if (localPropertyBearing.length > 0) {
    return {
      justified: false,
      why: `${localPropertyBearing.length} local record(s) already state the property (e.g. "${localPropertyBearing[0].name}")`,
    }
  }
  return { justified: true, why: "no local record states the property; a retail label is the only available evidence" }
}
