import { config } from "../../../config.js"
import { getCachedJudgeDecision, setCachedJudgeDecision } from "../../../utils/cache.js"
import { logger } from "../../../utils/logger.js"
import { judgeCacheKey, poolFingerprint } from "./candidate-pool.js"
import type { JudgeCandidate, JudgeDecision, JudgeOutcome, JudgeQuery, JudgeVerdict } from "./types.js"

/**
 * The semantic candidate judge.
 *
 * It chooses AMONG REAL RECORDS and never supplies a nutrient value: the entire reply is an id, a
 * verdict and a reason, and the caller copies the nutrients from the selected record verbatim. An
 * id outside the supplied set voids the reply, so the model cannot construct a candidate.
 *
 * DISABLED BY DEFAULT. askJudge() checks config.llm.judgeEnabled before it does anything else and
 * returns without touching the network, the cache or the clock — so with the flag off this module
 * cannot issue a request, cannot spend a token, and cannot influence a resolution.
 */

/** Bumped whenever SYSTEM or the rendered user prompt changes; part of the decision-cache key. */
export const JUDGE_PROMPT_VERSION = "1"

export type { JudgeQuery } from "./types.js"

const SYSTEM = `You match one recipe ingredient to a nutrition-database record.

You are a SEMANTIC JUDGE. You never supply nutrient values. You only decide which of the supplied
candidates, if any, is the same food as the ingredient.

DECIDE ON IDENTITY, NOT ON NUTRITION.
- Never prefer a candidate because it has fewer calories or less fat.
- Never prefer a candidate because it looks healthier or fits an expected recipe total.
- Nutrient values are shown only as EVIDENCE about what a record is, never as something to optimise.
- Never use energy, fat or any nutrient magnitude as a tie-breaker. Use a nutrient value to decide
  only when the ingredient explicitly states that numeric property (for example "10 % fat").

DISTINCTIONS THAT MATTER
- IDENTITY: the base food itself. Beef is not pork; a bean is not a lentil.
- STATE: raw / cooked / boiled / fried. A raw ingredient is not a cooked record.
- FORM: whole / ground / powder / flour / paste / juice. Flour is not the grain.
- PRESERVATION: fresh / dried / canned / frozen. Canned is not fresh.
- PLANT PART: leaf / seed / root. Coriander leaf and coriander seed are different foods.
- SOURCE: a product derived from a food must name that food. Pickle brine is not bottled water.
- EXPLICIT MODIFIERS: light, lean, reduced-fat, a stated percentage. If the ingredient states one,
  a candidate satisfies it only by stating it too.
- UNREQUESTED SPECIFICITY: a candidate that ADDS a transformation the ingredient did not ask for
  (canned, cooked, flour, powder) is NOT a better match for being more specific. Reject it unless
  the ingredient asked for that form.

DO NOT INVENT PRECISION.
If the ingredient says "lean" but not a percentage, do not pick a specific fat grade as though the
number were stated. A qualitative word is not a number.

When two or more candidates are equally compatible and the user's evidence does not justify
preferring one, return AMBIGUOUS rather than selecting arbitrarily.

BRANDED PRODUCTS
A branded retail product may stand in for a generic ingredient ONLY when the product genuinely is
that food and that variant. A product whose BRAND merely contains a word from the query cannot. A
sauce, dressing, ready meal or flavour variant is not the plain ingredient.

VERDICTS
- "selected": exactly one candidate is the same food and satisfies every stated attribute.
- "ambiguous": several candidates are materially different yet equally defensible, or the
  ingredient is under-specified (leaf vs seed unknown, "lean" without a number).
- "none": no candidate is the same food. This is a correct and expected answer — a wrong record is
  far worse than no record.

Reply with ONLY this JSON:
{"decision":"selected"|"ambiguous"|"none","candidateId":<id string or null>,"confidence":<0.0-1.0>,"reason":"<max 20 words>"}
When decision is "selected", candidateId MUST be one of the ids listed under CANDIDATES.`

/**
 * The ingredient's identity, normalized, for the decision-cache key. Everything that changes what
 * a correct answer would be, and nothing that does not.
 */
export function judgeQueryKey(q: JudgeQuery): string {
  return [
    q.structuredName, q.canonicalEnglish, q.canonicalGerman ?? "", q.coreFoodEnglish ?? "",
    q.state, q.form, q.preservation, q.fatPercent ?? "", q.category ?? "",
  ].join("|").toLowerCase()
}

/**
 * The candidate lines. Note what is absent: the deterministic score. Position already carries the
 * ranker's opinion, and a number invites the model to defer to it instead of reading the names.
 */
function renderCandidates(candidates: JudgeCandidate[]): string {
  return candidates.map((c) => {
    const n = c.nutrients
    return `- id=${c.id} | ${c.name}`
      + ` [provider=${c.provider}${c.dataType ? `/${c.dataType}` : ""}`
      + `${c.brand ? `; brand=${c.brand}` : ""}${c.category ? `; category=${c.category}` : ""}`
      + `; state=${c.state}; form=${c.form}; preservation=${c.preservation}`
      + `; kcal=${n.kcalPer100g ?? "?"}; protein=${n.proteinPer100g ?? "?"}`
      + `; carbs=${n.carbsPer100g ?? "?"}; fat=${n.fatPer100g ?? "?"}]`
  }).join("\n")
}

function buildUserPrompt(q: JudgeQuery, candidates: JudgeCandidate[]): string {
  const asked = [
    `structured name: ${q.structuredName}`,
    q.canonicalGerman ? `german: ${q.canonicalGerman}` : null,
    `english: ${q.canonicalEnglish}`,
    q.coreFoodEnglish ? `core food: ${q.coreFoodEnglish}` : null,
    `state: ${q.state}`,
    `form: ${q.form}; preservation: ${q.preservation}`
      + `${q.fatPercent != null ? `; stated fat percent: ${q.fatPercent}` : ""}`,
    q.category ? `category: ${q.category}` : null,
  ].filter(Boolean).join("\n")

  return `INGREDIENT\n${asked}\n\nCANDIDATES\n${renderCandidates(candidates)}`
}

/** Parses a reply, refusing anything that is not a verdict over the supplied pool. */
export function parseJudgeReply(
  content: string,
  candidates: JudgeCandidate[],
): { decision: JudgeDecision | null; invalidReason?: string } {
  const start = content.indexOf("{")
  const end = content.lastIndexOf("}")
  if (start === -1 || end <= start) return { decision: null, invalidReason: "no JSON object in reply" }

  let parsed: unknown
  try {
    parsed = JSON.parse(content.slice(start, end + 1))
  } catch {
    return { decision: null, invalidReason: "reply was not valid JSON" }
  }
  const o = parsed as Record<string, unknown>

  const verdict = o.decision
  if (verdict !== "selected" && verdict !== "ambiguous" && verdict !== "none") {
    return { decision: null, invalidReason: `unknown decision ${JSON.stringify(verdict)}` }
  }

  let candidateId: string | null = typeof o.candidateId === "string" ? o.candidateId : null
  if (verdict === "selected") {
    // The model may not construct a candidate. An id outside the supplied set voids the reply
    // entirely rather than degrading to "none" — a reply we cannot interpret is not a judgement.
    if (!candidateId || !candidates.some((c) => c.id === candidateId)) {
      return { decision: null, invalidReason: `selected id ${JSON.stringify(candidateId)} is not in the candidate set` }
    }
  } else {
    candidateId = null
  }

  return {
    decision: {
      verdict: verdict as JudgeVerdict,
      candidateId,
      confidence: typeof o.confidence === "number" && Number.isFinite(o.confidence)
        ? Math.min(1, Math.max(0, o.confidence))
        : 0,
      reason: typeof o.reason === "string" ? o.reason.slice(0, 160) : "",
    },
  }
}

const EMPTY = { latencyMs: 0, promptTokens: 0, completionTokens: 0 }

/**
 * Asks the judge about one ingredient, against an ALREADY-ORDERED pool.
 *
 * The caller owns ordering (orderCandidates) because ordering is what makes the question — and
 * therefore the cache key — reproducible; passing an unordered pool here would silently produce a
 * different question for the same candidate set.
 */
export async function askJudge(q: JudgeQuery, orderedCandidates: JudgeCandidate[]): Promise<JudgeOutcome> {
  // FIRST, before anything else: with the flag off this function is inert. No request, no cache
  // read, no clock. This is the guarantee that a disabled judge cannot change a resolution.
  if (!config.llm.judgeEnabled) return { decision: null, skipped: "disabled", ...EMPTY }
  if (!config.llm.enabled || !config.llm.apiKey) return { decision: null, skipped: "no-api-key", ...EMPTY }
  if (orderedCandidates.length === 0) return { decision: null, skipped: "no-candidates", ...EMPTY }

  const model = config.llm.judgeModel
  const fingerprint = poolFingerprint(orderedCandidates)
  const key = judgeCacheKey({
    promptVersion: JUDGE_PROMPT_VERSION, model, queryKey: judgeQueryKey(q), poolFingerprint: fingerprint,
  })

  const cached = getCachedJudgeDecision(key)
  if (cached) {
    // A cached "selected" still has to name a candidate that is actually on offer: the pool is
    // part of the key, but a key collision or a stale row must not smuggle in an unknown id.
    if (cached.verdict !== "selected" || orderedCandidates.some((c) => c.id === cached.candidateId)) {
      return { decision: cached, cached: true, ...EMPTY }
    }
  }

  const t0 = Date.now()
  let content = ""
  let promptTokens = 0
  let completionTokens = 0
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), config.llm.judgeTimeoutMs)
    try {
      const res = await fetch(`${config.llm.baseUrl}${config.llm.endpointUrl}`, {
        method: "POST",
        // The key is read from the environment and never logged, echoed or persisted.
        headers: { "content-type": "application/json", authorization: `Bearer ${config.llm.apiKey}` },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: SYSTEM },
            { role: "user", content: buildUserPrompt(q, orderedCandidates) },
          ],
          temperature: 0,
          response_format: { type: "json_object" },
        }),
        signal: controller.signal,
      })
      if (!res.ok) {
        return { decision: null, invalidReason: `http ${res.status}`, latencyMs: Date.now() - t0, promptTokens, completionTokens }
      }
      const data = (await res.json()) as {
        choices?: { message?: { content?: string } }[]
        usage?: { prompt_tokens?: number; completion_tokens?: number }
      }
      content = data.choices?.[0]?.message?.content ?? ""
      promptTokens = data.usage?.prompt_tokens ?? 0
      completionTokens = data.usage?.completion_tokens ?? 0
    } finally {
      clearTimeout(timer)
    }
  } catch (err) {
    // A hung or failed judge must never hold up a recipe; the deterministic result stands.
    return { decision: null, invalidReason: `request failed: ${(err as Error).name}`, latencyMs: Date.now() - t0, promptTokens, completionTokens }
  }

  const { decision, invalidReason } = parseJudgeReply(content, orderedCandidates)
  if (decision) {
    setCachedJudgeDecision(key, decision)
  } else {
    logger.warn({ structuredName: q.structuredName, invalidReason }, "Judge reply discarded")
  }
  return { decision, invalidReason, cached: false, latencyMs: Date.now() - t0, promptTokens, completionTokens }
}

export const __testing = { SYSTEM, buildUserPrompt, renderCandidates }
