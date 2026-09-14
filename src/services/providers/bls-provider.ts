import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import initSqlJs from "sql.js"
import { config } from "../../config.js"
import { logger } from "../../utils/logger.js"
import { getCachedProviderMatch, setCachedProviderMatch, isProviderMiss, markProviderMiss, buildQueryKey, normalizeKey } from "../../utils/cache.js"
import type { NutrientSet, ProviderMatch, FoodState } from "../../types.js"
import type { NutrientProvider, ProviderQuery } from "./types.js"
import { findMismatch, categoryConflict } from "./ranking.js"

/** See the queryKey comment in BlsProvider.lookup() — bump on any nameScore matching-behavior change. */
const BLS_MATCH_ALGORITHM_VERSION = "v5"

/**
 * BLS-specific tokenizer — deliberately NOT ranking.ts's shared tokenize(), which turns every
 * non-letter character (hyphens included) into a token boundary. That conflates two different
 * things in BLS names: the comma/slash BLS itself uses to separate a base food from its
 * preparation state ("Kartoffel geschält, roh") vs. a hyphen joining a composite DISH name
 * ("Kartoffel-Tomaten-Gratin mit Mozzarella" — a casserole, not plain potato). Splitting on
 * hyphens too let a bare "Kartoffel" query prefix-match that gratin dish outright (found live via
 * a state-mismatch smoke test). Keeping hyphens fused into their token avoids it, while comma/
 * slash/parens still split exactly like BLS's own state-qualifier syntax.
 */
function tokenizeBls(s: string): string[] {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
}

/**
 * Local BLS 4.0 Open Data reference table. Source: Max Rubner-Institut (MRI),
 * "Bundeslebensmittelschlüssel (BLS), Version 4.0 - Deutsche Nährstoffdatenbank" (2025-12-15),
 * licensed CC BY 4.0. Required attribution (also in README and resources/bls/bls-4.0.sqlite's
 * bls_meta table):
 *   Max Rubner-Institut (2025): Bundeslebensmittelschlüssel (BLS), Version 4.0 -
 *   Deutsche Nährstoffdatenbank. Karlsruhe. DOI: 10.25826/Data20251217-134202-0
 * Built by scripts/import_bls.py from the official export — every stored value is a verbatim
 * (unit-converted where noted) BLS figure; nothing here is hand-authored or estimated.
 */

interface BlsFoodRecord {
  blsCode: string
  nameDe: string
  nameDeNormalized: string
  nameEn: string | null
  inferredState: FoodState
  nutrients: NutrientSet
  /** Ordered token sequences (not just sets) — needed for prefix-match scoring, see scoreOne(). */
  tokensDe: string[]
  tokensEn: string[]
}

interface BlsData {
  records: BlsFoodRecord[]
  byNormalizedNameDe: Map<string, BlsFoodRecord[]>
}

function defaultDbPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url))
  return path.join(here, "../../../resources/bls/bls-4.0.sqlite")
}

let loadPromise: Promise<BlsData | null> | null = null

async function loadBlsData(): Promise<BlsData | null> {
  const dbPath = config.bls.dbPath || defaultDbPath()

  if (!fs.existsSync(dbPath)) {
    logger.warn({ dbPath }, "BLS reference database not found — BLS provider disabled for this run")
    return null
  }

  const SQL = await initSqlJs()
  const buffer = fs.readFileSync(dbPath)
  const db = new SQL.Database(buffer)

  const records: BlsFoodRecord[] = []
  const stmt = db.prepare(`SELECT bls_code, name_de, name_de_normalized, name_en, inferred_state,
    kcal_per_100g, protein_per_100g, carbs_per_100g, fat_per_100g, saturated_fat_per_100g,
    unsaturated_fat_per_100g, fiber_per_100g, sugar_per_100g, sodium_per_100g, cholesterol_per_100g
    FROM bls_foods`)

  try {
    while (stmt.step()) {
      const row = stmt.getAsObject() as Record<string, unknown>
      const nameDe = row.name_de as string
      const nameEn = (row.name_en as string | null) ?? null
      records.push({
        blsCode: row.bls_code as string,
        nameDe,
        nameDeNormalized: row.name_de_normalized as string,
        nameEn,
        inferredState: row.inferred_state as FoodState,
        nutrients: {
          kcalPer100g: row.kcal_per_100g as number | null,
          proteinPer100g: row.protein_per_100g as number | null,
          carbsPer100g: row.carbs_per_100g as number | null,
          fatPer100g: row.fat_per_100g as number | null,
          saturatedFatPer100g: row.saturated_fat_per_100g as number | null,
          // BLS 4.0 has no total-trans-fat component (only a single named conjugated-linoleic-acid
          // isomer, which isn't the same thing) — always unknown from this provider, never 0.
          transFatPer100g: null,
          unsaturatedFatPer100g: row.unsaturated_fat_per_100g as number | null,
          fiberPer100g: row.fiber_per_100g as number | null,
          sugarPer100g: row.sugar_per_100g as number | null,
          sodiumPer100g: row.sodium_per_100g as number | null,
          cholesterolPer100g: row.cholesterol_per_100g as number | null,
        },
        tokensDe: tokenizeBls(nameDe),
        tokensEn: tokenizeBls(nameEn ?? ""),
      })
    }
  } finally {
    stmt.free()
    db.close()
  }

  const byNormalizedNameDe = new Map<string, BlsFoodRecord[]>()
  for (const r of records) {
    const list = byNormalizedNameDe.get(r.nameDeNormalized)
    if (list) list.push(r)
    else byNormalizedNameDe.set(r.nameDeNormalized, [r])
  }

  logger.info({ count: records.length, dbPath }, "Loaded BLS 4.0 reference database")
  return { records, byNormalizedNameDe }
}

function getBlsData(): Promise<BlsData | null> {
  if (!loadPromise) loadPromise = loadBlsData()
  return loadPromise
}

/** Test-only: forces the next lookup to reload (and lets tests inject a fresh in-memory dataset). */
export function __resetBlsDataForTests(promise?: Promise<BlsData | null> | null): void {
  loadPromise = promise ?? null
}

export interface TestBlsFoodInput {
  blsCode: string
  nameDe: string
  nameEn?: string | null
  inferredState?: FoodState
  nutrients: NutrientSet
}

/**
 * Test-only: builds the same in-memory shape loadBlsData() produces from the real SQLite file,
 * from a small hand-written list of records — lets provider-logic tests (fuzzy scoring, state
 * rejection, missing-nutrient handling) run against deterministic fixtures instead of depending
 * on exactly what the real 7,140-row BLS export happens to contain.
 */
export function __buildTestBlsData(inputs: TestBlsFoodInput[]): BlsData {
  const records: BlsFoodRecord[] = inputs.map((input) => ({
    blsCode: input.blsCode,
    nameDe: input.nameDe,
    nameDeNormalized: normalizeKey(input.nameDe),
    nameEn: input.nameEn ?? null,
    inferredState: input.inferredState ?? "unknown",
    nutrients: input.nutrients,
    tokensDe: tokenizeBls(input.nameDe),
    tokensEn: tokenizeBls(input.nameEn ?? ""),
  }))

  const byNormalizedNameDe = new Map<string, BlsFoodRecord[]>()
  for (const r of records) {
    const list = byNormalizedNameDe.get(r.nameDeNormalized)
    if (list) list.push(r)
    else byNormalizedNameDe.set(r.nameDeNormalized, [r])
  }

  return { records, byNormalizedNameDe }
}

function jaccard(a: string[], b: string[]): number {
  const setA = new Set(a)
  const setB = new Set(b)
  if (setA.size === 0 || setB.size === 0) return 0
  let intersection = 0
  for (const t of setA) if (setB.has(t)) intersection++
  const union = setA.size + setB.size - intersection
  return union === 0 ? 0 : intersection / union
}

function isOrderedPrefix(prefix: string[], full: string[]): boolean {
  if (prefix.length === 0 || prefix.length > full.length) return false
  return prefix.every((t, i) => full[i] === t)
}

/**
 * Name-similarity score in [0, 1] for one query-vs-BLS-name comparison, tuned to German
 * compounding rather than reused blindly from ranking.ts's raw substring-containment approach
 * (which was tried first and rejected — see git history / PR discussion: it scored "Salz" against
 * the unrelated "Salzstangen" (pretzel sticks) exactly as high as "Kartoffel" against the
 * legitimate "Kartoffel geschält, roh", since both are plain substring matches).
 *
 * 1. Ordered token-sequence prefix (e.g. "Kartoffel" -> "Kartoffel geschält, roh") — strongest
 *    signal, a real word-boundary match. German-name-only (see `allowPrefixSuffix`).
 * 2. Single-token *suffix* match (e.g. "Zwiebel" -> "Speisezwiebel", "Salz" -> "Speisesalz") —
 *    German compounds are right-headed (the base/head word is the final morpheme), so this
 *    catches the very common bare-generic-word-vs-BLS-compound case precisely, while naturally
 *    rejecting the Salzstangen case ("Salzstangen" does NOT end in "salz" — it starts with it).
 *    A length-ratio guard avoids a short query getting credit for a wildly longer compound.
 *    German-name-only (see `allowPrefixSuffix`).
 * 3. Token-set Jaccard overlap as a general fallback (reordered/partial multi-word queries) —
 *    the only rule ever applied to BLS's English names.
 *
 * `allowPrefixSuffix` gates rules 1-2 to the German name only. BLS's English translations don't
 * follow the disciplined "base food, comma/slash-separated state qualifier" convention its German
 * names do — they're free-form phrases where the first word legitimately matching the query
 * doesn't mean the candidate IS that food. Found live: "Ei" (egg) prefix-matched "Egg pasta raw"
 * (English name of an egg-CONTAINING pasta, not egg), and "Paprika" prefix-matched "Paprika bacon
 * sausage" the same way — both structurally identical to the legitimate "Kartoffel" -> "Kartoffel
 * geschält, roh" case in form, but wrong in substance, because English noun phrases don't carry
 * BLS's German qualifier-comma convention that rules 1-2 were designed around.
 */
function nameScore(queryTokens: string[], candidateTokens: string[], allowPrefixSuffix: boolean): number {
  if (!allowPrefixSuffix) {
    return jaccard(queryTokens, candidateTokens) * 0.7
  }

  if (isOrderedPrefix(queryTokens, candidateTokens)) return 0.85

  // A minimum query length guards against coincidental endings: found live, "Ei" (egg, 2 letters)
  // matched "Teigwaren eifrei, roh" (EGG-FREE pasta) because "eifrei" happens to end in "ei" for
  // an unrelated reason (the German negation suffix "-frei" itself ends in "-ei", as do many
  // unrelated common words: Bäckerei, Brauerei, Molkerei, ...). Below this length, a coincidental
  // trailing-letter match is more likely than genuine compounding, and the risk is asymmetric —
  // an inverted/unrelated nutrition profile is worse than a missed match falling through to the
  // next provider. This does cost some legitimate short-word matches (e.g. "Ei" -> "Hühnerei"
  // roh, a real compound) but that trade favors safety, consistent with the conservative-fuzzy-
  // threshold requirement.
  const MIN_QUERY_LENGTH_FOR_SUFFIX_MATCH = 4

  if (queryTokens.length === 1 && queryTokens[0].length >= MIN_QUERY_LENGTH_FOR_SUFFIX_MATCH) {
    const q = queryTokens[0]
    // Strictly LONGER, not just endsWith: a genuine German compound like "Speisezwiebel" is one
    // fused token strictly longer than its head word "zwiebel". Requiring t.length > q.length
    // (not >=) excludes the trivial t === q case — found live: "Koriander" was matching
    // "Rote-Linsensuppe mit Koriander" (a whole lentil-soup dish) because "koriander" trivially
    // "ends with" itself as a bare standalone token in an unrelated multi-word dish name. That
    // exact-token-among-other-words case is weaker evidence and is left to the jaccard fallback
    // below, which naturally penalizes it via the dish's other, unrelated tokens.
    const suffixHit = candidateTokens.find((t) => t.length > q.length && t.endsWith(q) && t.length <= q.length + 8)
    if (suffixHit) return 0.6
  }

  return jaccard(queryTokens, candidateTokens) * 0.7 // scaled below prefix/suffix — a partial, unordered overlap is the weakest signal of the three
}

interface ScoredRecord {
  record: BlsFoodRecord
  score: number
  mismatchReason: string | null
  matchedViaEnglish: boolean
}

/** Conservative threshold for a *fuzzy* (non-exact-normalized-string) BLS match. Exact matches bypass this entirely. */
const FUZZY_MIN_SCORE = 50

function scoreCandidates(queryText: string, records: BlsFoodRecord[], category: string | null): ScoredRecord[] {
  const queryTokens = tokenizeBls(queryText)
  return records.map((record) => {
    const scoreDe = nameScore(queryTokens, record.tokensDe, true)
    const scoreEn = nameScore(queryTokens, record.tokensEn, false)
    const matchedViaEnglish = scoreEn > scoreDe
    const best = Math.max(scoreDe, scoreEn)
    const candidateName = matchedViaEnglish ? (record.nameEn ?? "") : record.nameDe
    const mismatchReason = findMismatch(queryText, candidateName) ?? (categoryConflict(category, candidateName) ? `category conflict: "${category}" vs "${candidateName}"` : null)

    let score = best * 70
    score += record.nutrients.kcalPer100g !== null ? 15 : -50
    if (mismatchReason) score -= 1000

    return { record, score, mismatchReason, matchedViaEnglish }
  })
}

/**
 * Picks the best acceptable candidate from a scored, sorted list, preferring one whose inferred
 * preparation state agrees with the query's structured state. A top candidate whose state is
 * *known* and *conflicts* with the query's known state is never accepted outright — the skill's
 * "reject candidate, don't guess" rule — but a same-score-band candidate with the right state is
 * tried first, and a candidate with *unknown* inferred state (BLS's name didn't say) is never
 * treated as a conflict either way.
 */
function pickBestByState(sorted: ScoredRecord[], queryState: FoodState, minScore: number): ScoredRecord | null {
  const acceptable = sorted.filter((c) => c.score >= minScore && !c.mismatchReason)
  if (acceptable.length === 0) return null

  const top = acceptable[0]
  const topConflicts = queryState !== "unknown" && top.record.inferredState !== "unknown" && top.record.inferredState !== queryState

  if (!topConflicts) return top

  // Look for a same-band alternative (within 20 points of the top score) whose state doesn't
  // conflict. queryState is provably not "unknown" here (topConflicts required it above). An
  // explicit state match is preferred outright over one BLS's name simply didn't specify — two
  // separate passes, not one combined predicate, so "unknown" never outranks a real match found
  // later in score order.
  const band = top.score - 20
  const inBand = acceptable.filter((c) => c.score >= band)
  const exactStateMatch = inBand.find((c) => c.record.inferredState === queryState)
  if (exactStateMatch) return exactStateMatch
  return inBand.find((c) => c.record.inferredState === "unknown") ?? null
}

function buildMatch(query: ProviderQuery, scored: ScoredRecord, isExact: boolean): ProviderMatch {
  const confidence = isExact ? 0.92 : Math.min(0.85, scored.score / 100)
  return {
    nutrients: scored.record.nutrients,
    canonicalName: query.foodName,
    brand: null,
    state: query.state,
    provider: "bls",
    providerId: scored.record.blsCode,
    productName: scored.matchedViaEnglish && scored.record.nameEn ? `${scored.record.nameDe} (${scored.record.nameEn})` : scored.record.nameDe,
    confidence,
  }
}

/**
 * BLS 4.0 provider — the primary local generic-route nutrition source. Matches against the
 * *structured* German Mealie food name first (never originalText), falling back to the LLM
 * batch normalizer's canonicalName only if the raw structured name finds nothing acceptable
 * (covers ambiguous/misspelled wording the normalizer already cleaned up). Exact normalized-name
 * match is preferred outright; fuzzy matching uses the same token-similarity approach as the
 * OFF/USDA providers (ranking.ts) but against an in-memory, precomputed BLS token index rather
 * than a network call.
 */
export class BlsProvider implements NutrientProvider {
  readonly name = "bls"

  async lookup(query: ProviderQuery): Promise<ProviderMatch | null> {
    const data = await getBlsData()
    if (!data) return null

    // Tried in order: raw structured name (highest fidelity), the LLM's normalized German name
    // (catches misspellings/dialect), then the LLM's English translation (last resort, weakened
    // via nameScore's allowPrefixSuffix=false for English candidates).
    const structuredName = query.structuredName?.trim()
    const canonicalGerman = query.canonicalGerman?.trim()
    const queryTexts = [structuredName, canonicalGerman, query.foodName].filter(
      (s, i, arr): s is string => !!s && arr.indexOf(s) === i,
    )

    // Unlike OFF/USDA, BLS matching is state-sensitive (pickBestByState) — the shared
    // buildQueryKey(foodName, brand) alone would let a "cooked" resolution get wrongly reused for
    // an "unknown"/"raw" query of the same food name. State is folded into the key text itself.
    //
    // BLS_MATCH_ALGORITHM_VERSION is prefixed the same way llmNutrientCacheKey's "v2:" is
    // (cache.ts) — the matching *algorithm* here (nameScore's prefix/suffix/jaccard rules) has
    // already changed twice within one deployment (fixing a trivial-exact-token false positive,
    // then a short-query coincidental-suffix false positive: "Ei" matching "eifrei" = EGG-FREE
    // pasta). provider_match_cache has no other versioning, so a future algorithm fix would
    // otherwise be silently masked by up to CACHE_MATCH_TTL (7 days by default) of stale matches
    // for any ingredient text already resolved once. Bump this string whenever nameScore's
    // matching behavior changes.
    const queryKey = buildQueryKey(`${BLS_MATCH_ALGORITHM_VERSION}:${queryTexts.join("|")}|${query.state}`, query.brand)
    const cached = getCachedProviderMatch(this.name, queryKey)
    if (cached) return cached
    if (isProviderMiss(this.name, queryKey)) return null

    for (const text of queryTexts) {
      const normalized = normalizeKey(text)
      const exactCandidates = data.byNormalizedNameDe.get(normalized)

      if (exactCandidates && exactCandidates.length > 0) {
        const withKcal = exactCandidates.find((r) => r.nutrients.kcalPer100g !== null) ?? exactCandidates[0]
        const stateOk = query.state === "unknown" || withKcal.inferredState === "unknown" || withKcal.inferredState === query.state
        if (stateOk) {
          const match = buildMatch(query, { record: withKcal, score: 100, mismatchReason: null, matchedViaEnglish: false }, true)
          setCachedProviderMatch(this.name, queryKey, match)
          return match
        }
        // Exact name match but conflicting state (e.g. query wants "cooked", only a "raw" entry
        // has this exact name) — fall through to fuzzy scoring, which might find a differently
        // *named* but state-matching BLS entry (e.g. "Kartoffel gekocht" vs the exact "Kartoffel").
      }

      const scored = scoreCandidates(text, data.records, query.category).sort((a, b) => b.score - a.score)
      const picked = pickBestByState(scored, query.state, FUZZY_MIN_SCORE)
      if (picked) {
        const match = buildMatch(query, picked, false)
        setCachedProviderMatch(this.name, queryKey, match)
        return match
      }
    }

    markProviderMiss(this.name, queryKey)
    return null
  }
}

export function createBlsProviderIfAvailable(): BlsProvider {
  return new BlsProvider()
}
