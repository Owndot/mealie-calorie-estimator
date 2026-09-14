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
    const expectedKcal = n.proteinPer100g * 4 + n.carbsPer100g * 4 + n.fatPer100g * 9
    const tolerance = Math.max(KCAL_MACRO_TOLERANCE_KCAL, expectedKcal * KCAL_MACRO_TOLERANCE_RATIO)
    if (Math.abs(n.kcalPer100g - expectedKcal) > tolerance) {
      return reject(
        `kcal/100g (${n.kcalPer100g}) inconsistent with macros (expected ~${expectedKcal.toFixed(0)}) for "${foodName}"`,
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
