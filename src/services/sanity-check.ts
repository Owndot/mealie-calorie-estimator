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

/**
 * Energy per gram for each sugar alcohol, as a band spanning the two regimes Open Food Facts
 * mixes together — it is an international dataset and a product may be labelled under either.
 *
 *   EU 1169/2011 Annex XIV: every polyol 2.4 kcal/g, erythritol explicitly 0.
 *   US FDA:                 erythritol 0, mannitol 1.6, isomalt 2.0, lactitol 2.0,
 *                           maltitol 2.1, xylitol 2.4, sorbitol 2.6.
 *
 * Per substance rather than one universal range, because "0 kcal/g" is true of erythritol and of
 * nothing else: a flat 0-2.4 band would have let a xylitol record claim zero energy, which is
 * not a labelling difference but an impossible product.
 *
 * `isomalt` is bounded rather than prefixed on purpose — isomaltulose is a genuine 4 kcal/g sugar.
 */
const POLYOL_FACTORS: { pattern: RegExp; min: number; max: number }[] = [
  { pattern: /\berythrit(ol)?\b/i, min: 0, max: 0 },
  { pattern: /\bmannit(ol)?\b/i, min: 1.6, max: 2.4 },
  { pattern: /\bisomalt\b/i, min: 2.0, max: 2.4 },
  { pattern: /\blactit(ol)?\b/i, min: 2.0, max: 2.4 },
  { pattern: /\bmaltit(ol)?\b/i, min: 2.1, max: 2.4 },
  { pattern: /\bxylit(ol)?\b|\bbirkenzucker\b/i, min: 2.4, max: 2.4 },
  { pattern: /\bsorbit(ol)?\b/i, min: 2.4, max: 2.6 },
]

/**
 * What to assume when a source reports polyol GRAMS but nothing says which polyol it is.
 *
 * The EU generic factor, as a point rather than a range down to zero. Erythritol is the only
 * polyol worth 0 kcal/g and a product made of it almost always says so, so treating an
 * unidentified polyol as possibly-erythritol would buy one rare case at the cost of accepting
 * impossible energy for every other sweetener. Unresolved is recoverable; a wrong number is not.
 */
const POLYOL_UNKNOWN = { min: 2.4, max: 2.4 }

/**
 * The polyol content of this food and the energy it can legitimately carry.
 *
 * Grams come from the source where the source reports them. Open Food Facts publishes
 * `polyols_100g`, but sparsely — the real production `Erythrit` records carry
 * `carbs: 100, polyols: null, kcal: 0` — so a food that IS a named sugar alcohol falls back to
 * treating its whole declared carbohydrate as that polyol. BLS and USDA have no such column at all.
 *
 * Naming the substances rather than a category is what keeps this narrow: seven compounds, not a
 * rule about sweeteners. Stevia, sucralose, aspartame and "Süßstoff" are deliberately absent —
 * they are not polyols, are dosed in milligrams, and keep facing the ordinary check.
 */
function polyolEnergy(n: NutrientSet, foodName: string): { grams: number; min: number; max: number } {
  const carbs = n.carbsPer100g ?? 0
  const named = POLYOL_FACTORS.filter((f) => f.pattern.test(foodName))
  const reported = n.polyolsPer100g
  const hasReported = typeof reported === "number" && Number.isFinite(reported) && reported > 0

  // Carbohydrate INCLUDES polyols under both regimes (EU 1169/2011 Annex I defines carbohydrate as
  // any metabolised carbohydrate, polyols among them; the FDA counts sugar alcohols inside Total
  // Carbohydrate). So the grams are clamped into the declared carbohydrate and subtracted from it
  // by the caller — counted once as polyol, never also as ordinary carbohydrate.
  const grams = hasReported
    ? Math.min(Math.max(0, reported), carbs)
    : (named.length > 0 ? carbs : 0)
  if (grams <= 0) return { grams: 0, min: 0, max: 0 }

  if (named.length === 0) return { grams, ...POLYOL_UNKNOWN }
  return {
    grams,
    min: Math.min(...named.map((f) => f.min)),
    max: Math.max(...named.map((f) => f.max)),
  }
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
    const polyol = polyolEnergy(n, foodName)
    const nonPolyolCarbs = Math.max(0, n.carbsPer100g - polyol.grams)
    const base = n.proteinPer100g * 4 + nonPolyolCarbs * 4 + n.fatPer100g * 9
    const lowKcal = base + polyol.grams * polyol.min
    const highKcal = base + polyol.grams * polyol.max
    const tolerance = Math.max(KCAL_MACRO_TOLERANCE_KCAL, highKcal * KCAL_MACRO_TOLERANCE_RATIO)
    if (n.kcalPer100g < lowKcal - tolerance || n.kcalPer100g > highKcal + tolerance) {
      const expected = polyol.grams > 0
        ? `~${lowKcal.toFixed(0)}-${highKcal.toFixed(0)}, ${polyol.grams.toFixed(0)} g of it polyol at ${polyol.min}-${polyol.max} kcal/g`
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
