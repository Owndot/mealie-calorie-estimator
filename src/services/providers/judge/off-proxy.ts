import { inferStateFromName } from "../ranking.js"
import { inferAttributesFromName, compoundSegments } from "../food-semantics.js"
import { searchOffProxyHits, type OffProxyHit } from "../off-provider.js"
import type { JudgeCandidate } from "./types.js"
import type { FoodAttributes } from "../../../types.js"

/**
 * Open Food Facts as a VERIFIED PROXY, never as a general database.
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

/**
 * The exclusions that still apply when OFF is the LAST source rather than a proxy for one
 * property. Much shorter on purpose.
 *
 * The proxy list above is tuned for dairy fat claims, where anything plant-based is noise. Reused
 * unchanged for a last resort it would reject the very ingredients this route exists to answer:
 * `en:plant-based-foods-and-beverages` is carried by hoisin sauce, rice vinegar, spice blends and
 * most of the specialty items BLS and USDA do not stock. What remains here is only the classes
 * that are never an ingredient, whatever their label says.
 */
const LAST_RESORT_EXCLUDED_CATEGORY_TAGS = [
  "en:baby-foods", "en:baby-milks", "en:meals", "en:prepared-meals", "en:pizzas", "en:sandwiches",
]

/** Raw OFF hits, fetched through the provider's own rate limiter, retries and User-Agent. */
export type OffHit = OffProxyHit

/**
 * Delegates to the OFF provider's own search, so this route shares its rate limiter, retries and
 * User-Agent instead of opening a second, unthrottled path. Wrapped in a function rather than
 * bound at module load: a test that mocks the provider module must not have to know that this
 * route exists in order to import anything that touches it.
 */
export function searchOff(query: string): Promise<OffHit[]> {
  return searchOffProxyHits(query)
}

export interface OffFilterResult {
  kept: JudgeCandidate[]
  /** Why each rejected hit was rejected, counted — the filter's own audit trail. */
  dropped: Record<string, number>
  rawHits: number
}

export interface OffFilterOptions {
  /**
   * Filter for the LAST-RESORT route rather than the property proxy: identity is taken from the
   * ingredient's own words, and only the never-an-ingredient categories are excluded.
   */
  lastResort?: boolean
  /** The structured ingredient name, i.e. what the cook wrote. Required when `lastResort`. */
  identityText?: string
}

/**
 * The words that actually identify this ingredient, longest first.
 *
 * "Longest" is a decent proxy for "most specific" in German, where narrowing happens by
 * compounding: `Hoisin-Sauce` yields `hoisin` ahead of `sauce`, `Leerdammer Leger` yields
 * `leerdammer`. Compound parts are included so `Proteinpulver` can still be recognised on a label
 * that prints "Protein Pulver", and descriptor words are dropped so a product is never admitted
 * on `frisch` or `gross` alone.
 */
function distinctiveTokens(identityText: string): string[] {
  const words = tokens(identityText).filter((t) => t.length >= 4 && !GENERIC_LABEL_WORDS.has(t))
  const withParts = new Set<string>(words)
  for (const w of words) for (const [a, b] of compoundSegments(w, 5)) { withParts.add(a); withParts.add(b) }
  const ranked = [...withParts].filter((t) => t.length >= 4 && !GENERIC_LABEL_WORDS.has(t)).sort((a, b) => b.length - a.length)
  // Only the most specific band is allowed to admit a product. Everything shorter than the
  // longest word by more than two characters is a category word, not an identity.
  return ranked.length === 0 ? [] : ranked.filter((t) => t.length >= ranked[0].length - 2)
}

/**
 * Words that appear on the label of an entire product CLASS and therefore identify nothing on
 * their own. Kept deliberately short: this exists to stop a shared category word admitting an
 * unrelated product, not to normalise vocabulary.
 */
const GENERIC_LABEL_WORDS = new Set([
  "sauce", "sosse", "pulver", "powder", "mischung", "mix", "gewuerz", "gewuerze", "spice", "spices",
  "paste", "creme", "cream", "essig", "vinegar", "bio", "oel", "oil", "extra", "natur", "original",
  "frisch", "fresh", "getrocknet", "dried", "gross", "klein", "gemahlen", "ground",
])

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
  options: OffFilterOptions = {},
): OffFilterResult {
  const core = coreTexts.flatMap((t) => tokens(t ?? "")).filter((t) => t.length > 3)
  const distinctive = options.lastResort ? distinctiveTokens(options.identityText ?? "") : []
  const excluded = options.lastResort ? LAST_RESORT_EXCLUDED_CATEGORY_TAGS : EXCLUDED_CATEGORY_TAGS
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
    const matchesToken = (c: string) => nameTokens.some((t) => t.includes(c) || c.includes(t))

    if (options.lastResort) {
      // The ingredient's OWN most distinctive word must appear on the label. The English core is
      // the wrong test here and is what left `Leerdammer Leger` unresolved: its inferred core is
      // "cheese", which a cheese label has no reason to print. The structured name carries the
      // identity a cook actually wrote, so that is what has to be recognisable — and requiring the
      // LONGEST word rather than any word is what stops `Hoisin-Sauce` matching a plain soy sauce
      // on the shared word "sauce".
      if (distinctive.length > 0 && !distinctive.some(matchesToken)) {
        drop("the ingredient's distinctive word is absent from the product NAME")
        continue
      }
    } else if (core.length > 0 && !core.some(matchesToken)) {
      drop("core food absent from the product NAME")
      continue
    }

    const cats = h.categories_tags ?? []
    if (cats.some((c) => excluded.includes(c))) { drop("excluded product category"); continue }

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
        // Carried so a judge-selected product faces the energy check with its polyols known.
        polyolsPer100g: num(n.polyols_100g),
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
  // A QUALITATIVE claim is a property of the product as sold, and generic composition databases
  // systematically do not carry marketing claims — BLS and USDA describe what a food IS, not how
  // it is labelled. A retail product is therefore the only source that can evidence "mager" or
  // "light" at all, so it is always worth consulting. This is a statement about the data sources,
  // not about any particular food.
  if (propertyKind === "reduced-fat") {
    return { justified: true, why: "a qualitative claim is a label property; generic databases do not carry labels" }
  }
  // A NUMERIC claim is something a composition database can express directly, and USDA files fat
  // grades as records of their own. If one states the number, OFF adds a network round trip and
  // nothing else.
  if (localPropertyBearing.length > 0) {
    return {
      justified: false,
      why: `${localPropertyBearing.length} local record(s) state the number (e.g. "${localPropertyBearing[0].name}")`,
    }
  }
  return { justified: true, why: "no local record states the requested number; a retail label is the only available evidence" }
}

/**
 * Is OFF justified as a LAST RESORT — not as a proxy for one property, but because nothing else
 * answered this ingredient at all?
 *
 * The proxy rule above asks "can the local databases already express the requested property?",
 * and answers `none` for an ingredient that made no property claim. That is right for its own
 * question and wrong as a general routing rule: `Leerdammer Leger`, `Hoisin-Sauce`, `Reisessig`
 * and `Proteinpulver` claim no property, have no BLS or USDA record, and so were never taken to
 * OFF at all — the one source that does stock branded and specialty foods.
 *
 * So: when the whole deterministic chain has produced no real record, the choice is not between
 * OFF and something better. It is between OFF and nothing. Retrieval alone decides nothing here;
 * the candidates still have to survive the filter and then be SELECTED by the judge, and the
 * nutrients are the chosen record's own.
 */
export function offLastResortJustified(
  hasRecord: boolean,
  localPropertyBearing: JudgeCandidate[],
): { justified: boolean; why: string } {
  if (hasRecord) return { justified: false, why: "a real record already answered this ingredient" }
  // The one case where OFF is known to add nothing: the ingredient made a NUMERIC claim and a
  // local record already states that number, so the property proxy above declined for a reason
  // that applies just as well here. Re-asking as a "last resort" would be the same network call
  // with the same answer.
  //
  // Note this deliberately does NOT require an empty local pool. A query for `Leerdammer Leger`
  // retrieves plenty of gate-surviving generic cheese — none of which is Leerdammer. Having
  // candidates is not the same as having the right one, and a branded product is precisely the
  // identity a composition database cannot hold.
  if (localPropertyBearing.length > 0) {
    return {
      justified: false,
      why: `a local record already states the requested number (e.g. "${localPropertyBearing[0].name}")`,
    }
  }
  return { justified: true, why: "no local record at all; OFF is the only remaining source" }
}
