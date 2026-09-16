import type { NutrientSet } from "../../../types.js"

/**
 * SEMANTIC JUDGE — shared vocabulary.
 *
 * The judge chooses AMONG REAL RECORDS the databases already found and the hard gates already
 * approved. It never supplies a nutrient value: its entire output is an id, a verdict and a
 * reason, and the caller copies the nutrients from the selected record verbatim. An id outside
 * the supplied set voids the reply, so the model cannot construct a candidate.
 *
 * Nothing in this directory is wired into the resolver's decision-making yet. PR B adds the
 * plumbing, the ordering, the fingerprint, the cache and the trigger vocabulary so that the
 * behaviour can be enabled later against evidence; `config.llm.judgeEnabled` is false by default
 * and askJudge() refuses to issue a request while it is.
 */

/** One record offered to the judge. Always a real row from a real provider. */
export interface JudgeCandidate {
  /** Stable identity the model must quote back: `${provider}:${providerId}`. */
  id: string
  provider: string
  providerId: string
  /** The record's own name, as its database spells it. */
  name: string
  dataType: string | null
  brand: string | null
  category: string | null
  state: string
  form: string
  preservation: string
  nutrients: NutrientSet
  /**
   * The deterministic ranker's score. Used ONLY for ordering — deliberately never rendered into
   * the prompt and never part of the fingerprint, so the model cannot anchor on the ranker's
   * opinion and a score drift that does not reorder the pool cannot invalidate a cached decision.
   * Position 1 already carries "this is what the ranker chose".
   */
  score: number
}

/** The ingredient as the judge is asked about it — everything that changes what a right answer is. */
export interface JudgeQuery {
  structuredName: string
  canonicalEnglish: string
  canonicalGerman: string | null
  coreFoodEnglish: string | null
  state: string
  form: string
  preservation: string
  fatPercent: number | null
  category: string | null
}

export type JudgeVerdict = "selected" | "ambiguous" | "none"

export interface JudgeDecision {
  verdict: JudgeVerdict
  /** Non-null only for "selected", and always an id from the pool that was supplied. */
  candidateId: string | null
  confidence: number
  reason: string
}

export interface JudgeOutcome {
  decision: JudgeDecision | null
  /** Set when no question was asked at all — "disabled", "no-candidates", "no-api-key". */
  skipped?: string
  /** Set when a reply was received and discarded, with the reason it was not usable. */
  invalidReason?: string
  /** True when the decision came from the decision cache rather than a request. */
  cached?: boolean
  latencyMs: number
  promptTokens: number
  completionTokens: number
}

/**
 * Why an ingredient is judge-ELIGIBLE. Deliberately a vocabulary of SEMANTIC SUSPICION, not a
 * confidence threshold: a low-confidence record is not automatically wrong, and — as
 * "Gurkenwasser" -> "Water, bottled, generic" showed at confidence 0.7 — a comfortable score is
 * not evidence of being right.
 *
 *   no-database-record            the chain would otherwise fabricate a value (llm-nutrient/unresolved)
 *   unmet-attribute               the accepted record does not state a modifier family the ingredient claimed
 *   unresolved-specificity        the ingredient states a preservation the accepted record contradicts
 *   unsatisfied-numeric-modifier  an explicit percentage the accepted record does not itself state
 *   partial-core-identity         the record answers only part of a multi-word core identity
 *   material-rival                several gate-surviving records are materially different yet close
 *   gate-suppressed-pool          records survived every hard gate but all scored below acceptance
 *   retail-variant-proxy          a formulated retail variant whose claim only an OFF proxy can answer
 *
 * `material-rival` and `gate-suppressed-pool` are properties of a candidate SET, which the
 * resolver does not see — they fire only when a caller supplies `pool` signals. They are part of
 * the vocabulary now so the provenance shape does not have to change when providers start
 * reporting those signals.
 */
export type JudgeTriggerReason =
  | "no-database-record"
  | "unmet-attribute"
  | "unresolved-specificity"
  | "unsatisfied-numeric-modifier"
  | "partial-core-identity"
  | "material-rival"
  | "gate-suppressed-pool"
  | "retail-variant-proxy"

export interface JudgeNeed {
  /** Every limb that fired, in a stable order. */
  reasons: JudgeTriggerReason[]
  /** The most consequential limb, for provenance and for log/metric grouping. */
  primary: JudgeTriggerReason
}
