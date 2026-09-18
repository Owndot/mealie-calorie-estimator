import type { NutrientSet } from "../types.js"

export interface SanityCheckResult {
  ok: boolean
  reason: string | null
}

const MAX_PLAUSIBLE_KCAL_PER_100G = 920 // pure fat/oil ceiling; nothing legitimate exceeds this
const KCAL_MACRO_TOLERANCE_KCAL = 60 // absolute slack for fiber/alcohol/rounding not captured in our macro set
const KCAL_MACRO_TOLERANCE_RATIO = 0.35 // relative slack on top of the absolute one

function ok(): SanityCheckResult {
  return { ok: true, reason: null }
}

function reject(reason: string): SanityCheckResult {
  return { ok: false, reason }
}

/** EU 1169/2011 energy conversion factors for polyols, in kcal/g. */
const KCAL_PER_G_POLYOL_MAX = 2.4 // the regulation's generic polyol factor
const KCAL_PER_G_POLYOL_MIN = 0 // erythritol, which the regulation rates at zero

/**
 * Foods that ARE a sugar alcohol, so their whole declared carbohydrate is polyol.
 *
 * Only consulted when the source reports no polyol figure of its own — BLS and USDA have no such
 * column, so an erythritol record from either looks like 100 g of sugar. Naming the substances
 * rather than a category is what keeps this narrow: it is a list of seven compounds, not a rule
 * about sweeteners. Stevia, sucralose, aspartame and "Süßstoff" are deliberately absent — they
 * are not polyols, are dosed in milligrams, and their records must keep facing the ordinary check.
 *
 * `isomalt` is bounded rather than prefixed on purpose: isomaltulose is a genuine 4 kcal/g sugar.
 */
const NAMED_POLYOL = /\b(erythrit(ol)?|xylit(ol)?|sorbit(ol)?|maltit(ol)?|mannit(ol)?|isomalt|lactit(ol)?|birkenzucker)\b/i

/**
 * How many of this food's carbohydrate grams are sugar alcohol: the reported figure when there is
 * one, otherwise all of them for a food that is itself a named polyol, otherwise none.
 */
function polyolGrams(n: NutrientSet, foodName: string): number {
  const carbs = n.carbsPer100g ?? 0
  const reported = n.polyolsPer100g
  if (typeof reported === "number" && Number.isFinite(reported) && reported > 0) {
    return Math.min(Math.max(0, reported), carbs)
  }
  return NAMED_POLYOL.test(foodName) ? carbs : 0
}

/**
 * Rejects nutrient candidates that are internally implausible, independent of which
 * provider produced them. Used to reject-and-try-next-provider per the skill's sanity rules.
 */
export function sanityCheckNutrients(n: NutrientSet, foodName: string): SanityCheckResult {
  const fields: [keyof NutrientSet, number][] = Object.entries(n)
    .filter(([, v]) => v !== null)
    .map(([k, v]) => [k as keyof NutrientSet, v as number])

  for (const [key, value] of fields) {
    if (value < 0) return reject(`negative ${key} (${value}) for "${foodName}"`)
  }

  if (n.kcalPer100g !== null && n.kcalPer100g > MAX_PLAUSIBLE_KCAL_PER_100G) {
    return reject(`implausible kcal/100g (${n.kcalPer100g}) for "${foodName}"`)
  }

  // Macro sanity: kcal should roughly equal 4*protein + 4*carbs + 9*fat (Atwater factors).
  // Skipped when any of the three macros is unknown, since we can't compute an expected value.
  // Also skipped for alcoholic beverages: ethanol contributes ~7 kcal/g and NutrientSet has no
  // field for it, so spirits/fortified wine/wine/beer legitimately carry far more kcal than
  // protein+carbs+fat alone would predict — flagging that here would reject genuine USDA/OFF
  // data for every recipe calling for wine, whisky, rum, sherry, etc.
  // "wein"/"bier" also match as a compound-word suffix (Rotwein, Weißwein, Weißbier, ...) since
  // German freely compounds nouns without a word boundary before the suffix.
  const isAlcoholic = /\b(sekt|likör|liqueur|spirituose|schnaps|rum|whisky|whiskey|wodka|vodka|gin|tequila|cognac|brandy|sherry|portwein|vermouth|wine|beer|liquor|spirits?)\b|wein\b|bier\b/i.test(foodName)
  if (
    !isAlcoholic &&
    n.kcalPer100g !== null &&
    n.proteinPer100g !== null &&
    n.carbsPer100g !== null &&
    n.fatPer100g !== null
  ) {
    // Sugar alcohols are declared as carbohydrate and are not worth 4 kcal/g. EU 1169/2011 rates
    // polyols generically at 2.4, and erythritol — which the gut absorbs and excretes unchanged —
    // explicitly at 0. Both are "carbohydrate" on a label, so a single factor cannot describe them:
    // measured in production, a real `Erythrit` record the judge had correctly selected reported
    // 100 g carbohydrate and 0 kcal, the formula expected ~400, and the record was thrown away.
    //
    // So where polyols are in play the expectation becomes a RANGE spanning those two factors
    // rather than a point. It widens by exactly the polyol grams and nothing else: a food with no
    // polyols keeps today's arithmetic to the digit, and erythritol at 900 kcal/100 g is still
    // rejected, because 900 is outside [0, 240] by far more than the tolerance.
    const polyols = polyolGrams(n, foodName)
    const nonPolyolCarbs = Math.max(0, n.carbsPer100g - polyols)
    const base = n.proteinPer100g * 4 + nonPolyolCarbs * 4 + n.fatPer100g * 9
    const lowKcal = base + polyols * KCAL_PER_G_POLYOL_MIN
    const highKcal = base + polyols * KCAL_PER_G_POLYOL_MAX
    const tolerance = Math.max(KCAL_MACRO_TOLERANCE_KCAL, highKcal * KCAL_MACRO_TOLERANCE_RATIO)
    if (n.kcalPer100g < lowKcal - tolerance || n.kcalPer100g > highKcal + tolerance) {
      const expected = polyols > 0
        ? `~${lowKcal.toFixed(0)}-${highKcal.toFixed(0)}, ${polyols.toFixed(0)} g of it polyol`
        : `~${highKcal.toFixed(0)}`
      return reject(
        `kcal/100g (${n.kcalPer100g}) inconsistent with macros (expected ${expected}) for "${foodName}"`,
      )
    }
  }

  // Salt/seasoning-type foods (near-zero kcal, meaningful sodium) must not carry meaningful calories.
  // NutrientSet keeps sodium in grams/100g (same convention as the providers), not milligrams —
  // pure salt is ~38-39 g sodium/100g. A food explicitly named "salt" reporting only a trace amount
  // is the classic sign of a g/mg unit-scale bug (e.g. 30g salt -> 12mg sodium instead of ~11.4g).
  const isSaltLike = /\b(salz|salt|meersalz|kochsalz)\b/i.test(foodName)
  if (isSaltLike) {
    if (n.kcalPer100g !== null && n.kcalPer100g > 20) {
      return reject(`salt-like ingredient "${foodName}" has implausible kcal/100g (${n.kcalPer100g})`)
    }
    if (n.sodiumPer100g !== null && n.sodiumPer100g < 20) {
      return reject(`salt-like ingredient "${foodName}" has implausible sodium/100g (${n.sodiumPer100g}g)`)
    }
  }

  if (n.saturatedFatPer100g !== null && n.fatPer100g !== null && n.saturatedFatPer100g > n.fatPer100g + 0.5) {
    return reject(`saturated fat (${n.saturatedFatPer100g}) exceeds total fat (${n.fatPer100g}) for "${foodName}"`)
  }

  if (n.sugarPer100g !== null && n.carbsPer100g !== null && n.sugarPer100g > n.carbsPer100g + 0.5) {
    return reject(`sugar (${n.sugarPer100g}) exceeds total carbs (${n.carbsPer100g}) for "${foodName}"`)
  }

  return ok()
}
