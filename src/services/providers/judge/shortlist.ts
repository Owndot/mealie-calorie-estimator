import { orderCandidates } from "./candidate-pool.js"
import { semanticTokens } from "../food-semantics.js"
import type { JudgeCandidate } from "./types.js"
import type { FoodAttributes } from "../../../types.js"

/**
 * Attribute-aware deterministic shortlist.
 *
 * Measured on the real corpus: a plain top-12-by-score pool is not sufficient once the judge is
 * invoked BECAUSE a property went unsatisfied. For "Rinderhackfleisch mager" the ten graded USDA
 * mince records sit at ranks 30–38 of 691 survivors, so the score cap hides every candidate that
 * says anything about leanness at all — the judge would be asked which record is lean while being
 * shown twelve records that are silent on the subject.
 *
 * So the shortlist is built in two deterministic halves: candidates that POSITIVELY express the
 * property under investigation, then the highest-scoring identity-compatible candidates. Both
 * halves are ordered by the production ordering, so the result is still a pure function of the
 * candidate set.
 *
 * What is NOT a preference, anywhere in here: energy, fat magnitude, "healthier", "lighter".
 * A candidate earns its place by STATING the property, never by scoring better on it. Exposing a
 * numeric grade to the judge is not the same as selecting it — "mager" states no number, and the
 * judge is still expected to refuse to invent one.
 */

/** Reserved share of the shortlist for property-bearing candidates, when any exist. */
const PROPERTY_SHARE = 0.5

/**
 * Words that assert reduced fat, for SHORTLIST ORDERING only.
 *
 * Deliberately separate from MODIFIER_FAMILIES, which decides what unmetModifierFamilies()
 * reports: that vocabulary is German-first and carries no English "lean", and widening it would
 * change which matches are flagged as incomplete across the whole system. This one only decides
 * which candidates get a reserved place in front of a judge, so it can be broader without moving
 * any existing verdict.
 *
 * It is also not the only way a candidate becomes visible: a retail candidate that passed the
 * strict OFF identity filter is represented regardless of whether this English vocabulary
 * recognises its wording — see RETAIL_SHARE.
 */
const REDUCED_FAT_WORDS = [
  "mager", "mageres", "magerer", "fettarm", "fettreduziert", "halbfett", "leicht", "leichte",
  "light", "lite", "lean", "lowfat", "low", "reduced", "skim", "skimmed", "nonfat", "fatfree",
  "entrahmt", "teilentrahmt", "diaet", "diet", "allege", "allegee", "cero",
]

export type PropertyKind = "numeric-fat" | "reduced-fat" | "preservation" | "form" | "state" | "none"

export interface PropertyUnderInvestigation {
  kind: PropertyKind
  /** Human-readable, for the report. */
  description: string
  /** Does this candidate POSITIVELY express it? */
  expressedBy: (c: JudgeCandidate) => boolean
}

/**
 * A claim is made by a WORD, not by a syllable. Exact tokens plus German adjective endings only —
 * the compound-head rule the marker tables use reads "tallow" as "low" and "Sahnetoffee" as a
 * cream claim, which on the first benchmark run made 388 of 691 beef records look like they
 * asserted leanness and wrongly suppressed the OFF proxy for the one case that needed it.
 */
const ADJECTIVE_ENDINGS = ["", "e", "er", "es", "en", "em"]

const hasWord = (text: string, words: string[]): boolean => {
  const tokens = semanticTokens(text)
  return tokens.some((t) => words.some((w) => ADJECTIVE_ENDINGS.some((e) => t === w + e)))
}

/** A percentage the candidate's own NAME states, e.g. "90% lean meat / 10% fat" -> [90, 10]. */
export function statedPercentages(name: string): number[] {
  return [...name.matchAll(/(\d+(?:[.,]\d+)?)\s*%/g)].map((m) => Number(m[1].replace(",", ".")))
}

/**
 * What is actually unresolved about this ingredient, derived from the query alone. The order is a
 * priority: an explicit number is the most specific claim a query can make.
 */
export function propertyUnderInvestigation(
  structuredName: string,
  attributes: FoodAttributes,
): PropertyUnderInvestigation {
  if (attributes.fatPercent != null) {
    const wanted = attributes.fatPercent
    return {
      kind: "numeric-fat",
      description: `an explicit ${wanted}% fat`,
      // The candidate's own NAME must state the number. Measured fat landing near the target is a
      // nutritional coincidence, not a claim: on the first run it made a strawberry charlotte
      // (7.5 g fat) and an instant oatmeal (7.46 g) "express" a 7 % cooking-cream query, and
      // suppressed the OFF proxy that actually states it. OFF products are exempt because the
      // strict filter has already checked their measured fat against the request — for a retail
      // product the measured value IS the label.
      expressedBy: (c) =>
        statedPercentages(c.name).some((p) => Math.abs(p - wanted) <= 0.5)
        || (c.provider === "off" && c.nutrients.fatPer100g !== null && Math.abs(c.nutrients.fatPer100g - wanted) <= 0.5),
    }
  }
  if (hasWord(structuredName, REDUCED_FAT_WORDS)) {
    return {
      kind: "reduced-fat",
      description: "a qualitative reduced-fat / lean / light claim",
      // Two exclusions, both measured rather than assumed:
      //
      //   a NUMERIC GRADE does not answer a qualitative claim. "90% lean meat / 10% fat" states a
      //   number the ingredient never gave, and treating it as evidence for "mager" is exactly the
      //   invented precision this is supposed to avoid. It stays in the shortlist as a candidate;
      //   it just does not count as the property being expressed.
      //
      //   "lean" in USDA's ANATOMICAL sense is not a claim. "Beef, round, tip round, separable
      //   lean and fat" describes which part of the carcass was analysed — a component, not a
      //   leanness assertion. Measured: without this, 386 of 691 beef records "asserted" leanness.
      expressedBy: (c) => hasWord(c.name, REDUCED_FAT_WORDS)
        && statedPercentages(c.name).length === 0
        && !/\blean\s+(and|only)\b/i.test(c.name),
    }
  }
  if (attributes.preservation !== "unknown") {
    const wanted = attributes.preservation
    return { kind: "preservation", description: `preservation "${wanted}"`, expressedBy: (c) => c.preservation === wanted }
  }
  if (attributes.form !== "unknown") {
    const wanted = attributes.form
    return { kind: "form", description: `form "${wanted}"`, expressedBy: (c) => c.form === wanted }
  }
  return { kind: "none", description: "no specific unresolved property", expressedBy: () => false }
}

export interface Shortlist {
  property: PropertyUnderInvestigation
  /** What the judge is shown, in deterministic order. */
  offered: JudgeCandidate[]
  /** Property-bearing candidates, in deterministic order (may exceed what was offered). */
  propertyBearing: JudgeCandidate[]
  /** Candidates a plain top-N-by-score cap would have offered instead. */
  scoreOnlyTopN: JudgeCandidate[]
  /** Property-bearing candidates that a plain score cap would have LOST. */
  rescuedFromTruncation: JudgeCandidate[]
  totalSurvivors: number
}

/** Share of the shortlist reserved for strictly-filtered retail candidates, when any exist. */
const RETAIL_SHARE = 0.25

export function buildShortlist(
  survivors: JudgeCandidate[],
  structuredName: string,
  attributes: FoodAttributes,
  limit: number,
  retailCandidates: JudgeCandidate[] = [],
): Shortlist {
  const property = propertyUnderInvestigation(structuredName, attributes)
  const ordered = orderCandidates([...survivors, ...retailCandidates], Number.MAX_SAFE_INTEGER)
  const scoreOnlyTopN = ordered.slice(0, limit)

  const propertyBearing = ordered.filter((c) => property.expressedBy(c))
  const reserved = property.kind === "none" ? 0 : Math.min(propertyBearing.length, Math.floor(limit * PROPERTY_SHARE))

  const offered: JudgeCandidate[] = propertyBearing.slice(0, reserved)
  const taken = new Set(offered.map((c) => c.id))

  // Retail candidates get places of their own, decided by the strict OFF pre-filter rather than by
  // the English marker vocabulary above. The vocabulary can only recognise claims it has words
  // for, so letting it gate visibility would mean a German or French label is judged by whether an
  // English table happens to list its wording — and a retail label is precisely where a
  // qualitative claim lives. The pre-filter has already established the product is plausibly the
  // same food; whether its wording expresses the claim is the judge's question, not the table's.
  const retail = ordered.filter((c) => c.provider === "off" && !taken.has(c.id))
  for (const c of retail.slice(0, Math.floor(limit * RETAIL_SHARE))) {
    offered.push(c)
    taken.add(c.id)
  }

  for (const c of ordered) {
    if (offered.length >= limit) break
    if (taken.has(c.id)) continue
    offered.push(c)
    taken.add(c.id)
  }

  const inTopN = new Set(scoreOnlyTopN.map((c) => c.id))
  return {
    property,
    offered,
    propertyBearing,
    scoreOnlyTopN,
    rescuedFromTruncation: offered.filter((c) => property.expressedBy(c) && !inTopN.has(c.id)),
    totalSurvivors: ordered.length,
  }
}
