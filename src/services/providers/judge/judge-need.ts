import { fatApproximate, inferAttributesFromName, statedModifierFamilies } from "../food-semantics.js"
import { answersOnlyPartOfCore } from "../ranking.js"
import type { FoodAttributes, FoodType, ProviderMatch } from "../../../types.js"
import type { JudgeNeed, JudgeTriggerReason } from "./types.js"

/**
 * Is this ingredient judge-ELIGIBLE?
 *
 * The one thing this deliberately is NOT is a confidence threshold. Two production findings shaped
 * that:
 *
 *   "Gurkenwasser" resolved to "Water, bottled, generic" at confidence 0.7 with no unmet
 *   attributes — comfortably above any threshold, and the wrong food. A score says how well a name
 *   matched, not whether the record is the ingredient.
 *
 *   "gemahlener Koriander" resolves to "Spices, coriander seed" at confidence 0.7 and is exactly
 *   right. The same number, opposite verdicts.
 *
 * So eligibility is a vocabulary of SEMANTIC SUSPICION — a specific, nameable thing that is
 * unresolved about this ingredient. Each limb below is a question the deterministic path could not
 * answer, not a judgement that it answered badly. See JudgeTriggerReason.
 *
 * Returning a need does not mean the judge runs, still less that anything is replaced. PR B
 * records the reason and stops there.
 */

export interface JudgeNeedInput {
  /** The ingredient as classified: what it claims about itself. */
  structuredName: string
  canonicalEnglish: string
  coreFoodEnglish: string | null
  attributes: FoodAttributes
  foodType: FoodType
  /** The chain's outcome, or null when nothing matched at all. */
  match: ProviderMatch | null
  /** Which provider ultimately supplied the nutrients. */
  fallbackStatus: string
  /**
   * Optional signals about the candidate SET, which the resolver cannot see. Providers do not
   * report these yet; the limbs that consume them stay silent until they do.
   */
  pool?: PoolSignals
}

export interface PoolSignals {
  /** Records that survived every hard gate. */
  gateSurvivors: number
  /** Of those, how many scored below MIN_ACCEPTABLE_SCORE. */
  belowAcceptance: number
  /**
   * True when two or more gate survivors are materially different foods (differing identity,
   * state, plant part, or energy beyond the ranker's material threshold) yet score close enough
   * that the deterministic order does not actually distinguish them.
   */
  materialRival: boolean
}

/** Providers whose answer is a real database record rather than a generated value. */
const RECORD_PROVIDERS = new Set(["mealie-recipe", "bls", "usda-local", "off"])

/** An explicit preservation the ingredient actually stated — "unknown" claims nothing. */
function statedPreservation(attrs: FoodAttributes): string | null {
  return attrs.preservation && attrs.preservation !== "unknown" ? attrs.preservation : null
}

export function judgeNeed(input: JudgeNeedInput): JudgeNeed | null {
  const reasons: JudgeTriggerReason[] = []
  const { match, attributes } = input
  const hasRecord = match !== null && RECORD_PROVIDERS.has(input.fallbackStatus)

  // T1 — the chain would otherwise fabricate a number. The single strongest reason to ask: there
  // is nothing to protect, so a real record can only be an improvement.
  if (!hasRecord) {
    reasons.push("no-database-record")
  }

  if (hasRecord && match) {
    const recordName = match.productName ?? ""

    // T2 — the ingredient made a modifier claim ("mager", "light") that the chosen record's own
    // name does not state. Computed upstream by unmetModifierFamilies and already carried in
    // provenance; this limb only reads it, so the two can never disagree.
    if ((match.unmetAttributes?.length ?? 0) > 0) {
      reasons.push("unmet-attribute")
    }

    // T3 — an explicit percentage. Answered by the record's MEASURED fat, on the same terms the
    // gates already use: fatConflict rejects a record outside tolerance upstream, so what reaches
    // here is either effectively exact (satisfied — "Rinderhack 10% Fett" against the 90/10
    // record), merely within tolerance (fatApproximate: close, but the stated number is not what
    // this record is), or silent about fat entirely. The latter two leave the number unanswered.
    //
    // Deliberately NOT read from the record's name: German records quote "Fett i. Tr." (fat in dry
    // matter), a different scale that mis-compares by roughly a factor of two — which is why
    // fatConflict measures rather than parses, and why this limb agrees with it.
    if (attributes.fatPercent != null) {
      const measured = match.nutrients.fatPer100g
      if (measured === null || fatApproximate(attributes.fatPercent, measured)) {
        reasons.push("unsatisfied-numeric-modifier")
      }
    }

    // T2b — the ingredient states a preservation and the record states a DIFFERENT one. Narrow on
    // purpose: preservationConflict already rejects the clear cases, so this is a backstop for
    // records the gate let through, and it is restricted to preservation because form is the
    // dimension where a legitimate match routinely differs ("ground coriander" is correctly
    // answered by "Spices, coriander seed").
    const wanted = statedPreservation(attributes)
    const offered = inferAttributesFromName(recordName).preservation
    if (wanted && offered !== "unknown" && offered !== wanted) {
      reasons.push("unresolved-specificity")
    }

    // Semantic suspicion despite a comfortable score: the record answers the generic half of a
    // multi-word identity and drops the half that carried it ("chili pepper" -> "Peppers, sweet,
    // red, raw"). A question, not a verdict — "bell pepper" -> "Peppers, sweet, raw" has the same
    // shape and is correct, which is precisely why it belongs to a judge and not to another
    // lexical rule.
    if (answersOnlyPartOfCore(input.coreFoodEnglish, recordName)) {
      reasons.push("partial-core-identity")
    }
  }

  // T6 — a formulated retail variant. Generic composition databases do not hold "7 % cooking
  // cream" or "light mayonnaise"; a real packaged product does. Scoped to a claim that is actually
  // outstanding, so an ordinary processed food with a satisfied identity never qualifies.
  const claimOutstanding = reasons.includes("unmet-attribute")
    || reasons.includes("unsatisfied-numeric-modifier")
    || (!hasRecord && (attributes.fatPercent != null || statedModifierFamilies(input.structuredName).length > 0))
  if (input.foodType === "processed_single_food" && claimOutstanding) {
    reasons.push("retail-variant-proxy")
  }

  // Set-level limbs. Silent until a provider reports what its candidate set looked like.
  if (input.pool) {
    if (input.pool.materialRival) reasons.push("material-rival")
    if (!hasRecord && input.pool.gateSurvivors > 0 && input.pool.belowAcceptance > 0) {
      reasons.push("gate-suppressed-pool")
    }
  }

  if (reasons.length === 0) return null

  // Stable priority, so provenance groups the same way every run. Ordered by how much the judge
  // could do about it: nothing to lose first, then an unanswered claim, then a suspicion.
  const PRIORITY: JudgeTriggerReason[] = [
    "no-database-record",
    "gate-suppressed-pool",
    "unsatisfied-numeric-modifier",
    "unmet-attribute",
    "unresolved-specificity",
    "partial-core-identity",
    "material-rival",
    "retail-variant-proxy",
  ]
  const ordered = PRIORITY.filter((r) => reasons.includes(r))
  return { reasons: ordered, primary: ordered[0] }
}
