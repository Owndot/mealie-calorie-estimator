import { config } from "../../config.js"
import { logger } from "../../utils/logger.js"
import { callLlm } from "../llm-client.js"
import { getCachedRerank, setCachedRerank } from "../../utils/cache.js"
import type { FoodAttributes } from "../../types.js"

/**
 * LLM-assisted reranking of DATABASE candidates.
 *
 * The model is a semantic judge between records that already exist, never a source of nutrition.
 * It receives a handful of retrieved candidates and answers with one of their ids or NONE; the
 * nutrients that end up in the recipe are still read from whichever BLS/USDA/OFF record it names.
 * Retrieval stays deterministic and local — nothing here ever sees more than a page of candidates,
 * and the 7,140-row BLS table is never sent anywhere.
 *
 * Position in the pipeline:
 *
 *   ingredient -> deterministic retrieval -> HARD SEMANTIC GATES -> candidate set
 *              -> [rerank, only when ambiguous] -> selected database record -> database nutrients
 *
 * The gates run FIRST and are not advisory: a candidate carrying a food-type, attribute,
 * core-identity, specificity or category conflict is removed from the set before this module sees
 * it, so the model cannot reinstate a record the deterministic rules already ruled out. It can only
 * reorder what survived, or decline.
 */

/** Bump when the prompt, the validation rules or the candidate fields change. */
const RERANK_CACHE_VERSION = "v1"

export interface RerankCandidate {
  /** The provider's own record id (BLS code / FDC id / OFF code) — the cache and the caller key on this. */
  providerId: string
  productName: string
  kcalPer100g: number | null
  form: string
  preservation: string
  /** The deterministic score this candidate earned, so the model can see how close the field is. */
  score: number
}

export interface RerankQuery {
  provider: string
  /** The raw structured Mealie name — the highest-fidelity statement of what the cook wrote. */
  structuredName: string
  canonicalGerman?: string | null
  canonicalEnglish?: string | null
  coreFood?: string | null
  state: string
  attributes: FoodAttributes
}

export interface RerankDecision {
  providerId: string | null
  confidence: number
  reason: string
}

/**
 * Identity of one rerank question: the ingredient AND the exact candidate set it was asked about.
 * Folding the candidate ids into the key means any change to retrieval — a new BLS version, a
 * different OFF page, a scoring change that admits one more record — automatically invalidates the
 * stored answer instead of silently reusing a judgement about a different set of options.
 */
function rerankCacheKey(query: RerankQuery, candidates: RerankCandidate[]): string {
  const identity = [query.structuredName, query.canonicalGerman, query.canonicalEnglish, query.coreFood]
    .filter(Boolean)
    .join("|")
    .toLowerCase()
  const attrs = `${query.attributes.form}/${query.attributes.preservation}/${query.attributes.fatPercent ?? "-"}`
  const set = candidates.map((c) => c.providerId).join(",")
  return `${RERANK_CACHE_VERSION}:${query.provider}:${identity}|${query.state}|${attrs}|${set}`
}

function buildPrompt(query: RerankQuery, candidates: RerankCandidate[]): string {
  const lines = candidates.map((c, i) =>
    `${i + 1}. ${c.productName}` +
    ` [kcal/100g=${c.kcalPer100g ?? "?"}; form=${c.form}; preservation=${c.preservation}; score=${Math.round(c.score)}]`)

  const asked = [
    `structured name: ${query.structuredName}`,
    query.canonicalGerman ? `german: ${query.canonicalGerman}` : null,
    query.canonicalEnglish ? `english: ${query.canonicalEnglish}` : null,
    query.coreFood ? `core food: ${query.coreFood}` : null,
    `state: ${query.state}`,
    `form: ${query.attributes.form}; preservation: ${query.attributes.preservation}`,
  ].filter(Boolean).join("\n")

  // Deliberately short. This runs per ambiguous ingredient, so every sentence has to earn its
  // tokens, and the rules are the same ones the deterministic gates encode — stated once, in the
  // model's own terms, rather than re-derived per food.
  return `You are matching one recipe ingredient to a nutrition-database record.

INGREDIENT
${asked}

CANDIDATES
${lines.join("\n")}

RULES
- Pick the candidate that is the SAME FOOD as the ingredient.
- A candidate may be more GENERIC than the ingredient (Basmati rice -> plain rice is fine).
- A candidate must NOT add anything the ingredient did not say: a different base ingredient or
  grain, a variety, a plant part (leaf/seed/root), a preparation, a preservation state
  (fresh/dried/canned/frozen), or added sugar/fat.
- If the ingredient DOES state an attribute (canned, dried, ground, fresh), prefer a candidate
  that states the same one over a candidate that is silent about it.
- Answer NONE whenever no candidate is the same food, or when several are plausible and they
  differ nutritionally and nothing in the ingredient says which. NONE is a correct, expected
  answer — a wrong record is far worse than no record.

Reply with ONLY this JSON, no markdown, no explanation:
{"selected": <candidate number or null>, "confidence": <0.0-1.0>, "reason": "<max 15 words>"}`
}

const MAX_REASON_LENGTH = 200

/**
 * Parses the model's reply into a decision, or null when anything at all is wrong with it.
 *
 * Every rejection here is equivalent to NONE, which is equivalent to "the LLM did not
 * participate": the caller falls back to its deterministic outcome. There is deliberately no
 * lenient path that guesses what the model meant.
 */
export function parseRerankReply(content: string, candidates: RerankCandidate[]): RerankDecision | null {
  const start = content.indexOf("{")
  const end = content.lastIndexOf("}")
  if (start === -1 || end <= start) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(content.slice(start, end + 1))
  } catch {
    return null
  }
  if (typeof parsed !== "object" || parsed === null) return null
  const obj = parsed as Record<string, unknown>

  const confidence = typeof obj.confidence === "number" && Number.isFinite(obj.confidence)
    ? Math.min(1, Math.max(0, obj.confidence))
    : null
  if (confidence === null) return null

  const reason = typeof obj.reason === "string" ? obj.reason.slice(0, MAX_REASON_LENGTH) : ""

  const selected = obj.selected
  if (selected === null || selected === undefined || selected === "NONE" || selected === "none") {
    return { providerId: null, confidence, reason }
  }

  // A number, and a number that actually addresses a candidate we offered. A model that invents
  // "12" for an 8-candidate list, or echoes a plausible-looking database code, must not be able to
  // select anything at all — which is why candidates are numbered 1..N rather than addressed by
  // their real provider ids.
  const index = typeof selected === "number" ? selected : Number.parseInt(String(selected), 10)
  if (!Number.isInteger(index) || index < 1 || index > candidates.length) return null

  return { providerId: candidates[index - 1].providerId, confidence, reason }
}

/**
 * Returns the reranked choice, or null to mean "carry on deterministically".
 *
 * Null covers every non-answer identically — disabled, no candidates, cache miss with a failing
 * call, timeout, malformed JSON, a hallucinated candidate number, or a confidence below the
 * threshold. The caller must treat it exactly as it would have behaved with no LLM at all.
 */
export async function rerankCandidates(
  query: RerankQuery,
  candidates: RerankCandidate[],
): Promise<RerankDecision | null> {
  if (!config.llm.enabled || !config.llm.apiKey || !config.llm.rerankEnabled) return null
  if (candidates.length === 0) return null

  const offered = candidates.slice(0, config.llm.rerankMaxCandidates)
  const key = rerankCacheKey(query, offered)

  const cached = getCachedRerank(key)
  if (cached !== undefined) {
    logger.debug({ provider: query.provider, foodName: query.structuredName, cached: true }, "Rerank: served from cache")
    return gateOnConfidence(query, cached)
  }

  const call = await callLlm(buildPrompt(query, offered), {
    purpose: "candidate-rerank",
    temperature: 0,
    // The reply is one small JSON object; a large budget only buys a slower failure.
    maxTokens: 120,
    timeoutMs: config.llm.rerankTimeoutMs,
  })
  if (!call.ok) return null // already logged with its phase

  const decision = parseRerankReply(call.content, offered)
  if (!decision) {
    logger.warn({ provider: query.provider, foodName: query.structuredName }, "Rerank: unusable reply, continuing deterministically")
    return null
  }

  // Cached BEFORE the confidence gate, and cached for NONE too: both are real answers about this
  // exact candidate set, and re-asking would spend a call to be told the same thing. The gate is
  // applied on the way out instead, so a cache hit and a fresh call behave identically.
  setCachedRerank(key, decision)
  return gateOnConfidence(query, decision)
}

function gateOnConfidence(query: RerankQuery, decision: RerankDecision): RerankDecision | null {
  if (decision.confidence >= config.llm.rerankMinConfidence) return decision
  logger.info(
    { provider: query.provider, foodName: query.structuredName, confidence: decision.confidence, reason: decision.reason },
    "Rerank: confidence below threshold, continuing deterministically",
  )
  return null
}
