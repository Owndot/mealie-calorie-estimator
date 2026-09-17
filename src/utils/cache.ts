import initSqlJs, { type Database } from "sql.js"
import fs from "node:fs"
import path from "node:path"
import { config } from "../config.js"
import type { NutrientSet, ProviderMatch } from "../types.js"
import { logger } from "./logger.js"
import { normalizeIdentityText } from "./text-normalize.js"

let db: Database
let saveTimer: ReturnType<typeof setTimeout> | null = null
let isInitialized = false

function scheduleSave(): void {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    try {
      const data = db.export()
      const dir = path.dirname(config.cache.dbPath)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }
      fs.writeFileSync(config.cache.dbPath, Buffer.from(data))
    } catch (err) {
      logger.error({ err }, "Failed to save cache database")
    }
    saveTimer = null
  }, 5000)
}

/** Flushes any pending debounced save immediately (used on shutdown / in tests). */
export function flushCache(): void {
  if (!saveTimer) return
  clearTimeout(saveTimer)
  saveTimer = null
  try {
    const data = db.export()
    const dir = path.dirname(config.cache.dbPath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    fs.writeFileSync(config.cache.dbPath, Buffer.from(data))
  } catch (err) {
    logger.error({ err }, "Failed to flush cache database")
  }
}

export async function initCache(): Promise<void> {
  if (isInitialized) return

  const dbPath = config.cache.dbPath
  const dir = path.dirname(dbPath)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }

  const SQL = await initSqlJs()

  if (fs.existsSync(dbPath)) {
    const buffer = fs.readFileSync(dbPath)
    db = new SQL.Database(buffer)
  } else {
    db = new SQL.Database()
  }

  // Successful provider resolutions, keyed by (provider, query_key). query_key encodes
  // canonical food name + brand so generic and branded lookups for the same food name never
  // collide/poison each other, even within the same provider.
  db.run(`CREATE TABLE IF NOT EXISTS provider_match_cache (
    provider TEXT NOT NULL,
    query_key TEXT NOT NULL,
    canonical_name TEXT NOT NULL,
    brand TEXT,
    state TEXT NOT NULL,
    provider_id TEXT,
    product_name TEXT,
    confidence REAL NOT NULL,
    nutrients TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    data_type TEXT,
    food_type TEXT,
    match_reason TEXT,
    PRIMARY KEY (provider, query_key)
  )`)

  // Migration: data_type/food_type/match_reason were added after provider_match_cache already
  // existed on deployed volumes — CREATE TABLE IF NOT EXISTS is a no-op there, so these ALTER
  // TABLEs cover the upgrade. Ignore the "duplicate column" error on a fresh table that already
  // has them from the CREATE above. Found live: food_type/match_reason were added to ProviderMatch
  // without a matching cache migration, so every cache HIT (as opposed to a fresh provider fetch)
  // silently returned them as undefined — provenance looked fine on the first resolution of an
  // ingredient and silently lost its foodType/matchReason on every subsequent cache hit for the
  // same query, inconsistently, across recipes.
  for (const col of ["data_type", "food_type", "match_reason"]) {
    try {
      db.run(`ALTER TABLE provider_match_cache ADD COLUMN ${col} TEXT`)
    } catch {
      // already present
    }
  }

  // Provenance that post-dates the original table. CREATE TABLE IF NOT EXISTS does nothing to an
  // existing database, so the column is added explicitly when absent. Without it a cache HIT
  // silently dropped llmReranked/rerankReason/unmetAttributes — observed in production as a match
  // reported at a rerank-only confidence of 0.8 while claiming it had never been reranked.
  const columns = new Set<string>()
  const info = db.prepare("PRAGMA table_info(provider_match_cache)")
  try {
    while (info.step()) columns.add(String((info.getAsObject() as Record<string, unknown>).name))
  } finally {
    info.free()
  }
  if (!columns.has("provenance")) {
    db.run("ALTER TABLE provider_match_cache ADD COLUMN provenance TEXT")
  }

  // Negative cache: a provider had no acceptable match for this query. Avoids re-hitting rate
  // limited network providers (OFF/USDA) for a food that is known not to resolve there.
  db.run(`CREATE TABLE IF NOT EXISTS provider_miss_cache (
    provider TEXT NOT NULL,
    query_key TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (provider, query_key)
  )`)

  db.run(`CREATE TABLE IF NOT EXISTS llm_estimate_cache (
    lookup_key TEXT PRIMARY KEY,
    grams REAL NOT NULL,
    updated_at INTEGER NOT NULL
  )`)

  db.run(`CREATE TABLE IF NOT EXISTS llm_nutrient_cache (
    food_name TEXT PRIMARY KEY,
    nutrients TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`)

  // One row per (ingredient identity + exact candidate set) rerank question. provider_id is the
  // empty string for a NONE verdict, which is cached like any other answer: it is a real judgement
  // about this candidate set, and re-asking would spend a call to be told the same thing.
  db.run(`CREATE TABLE IF NOT EXISTS llm_rerank_cache (
    lookup_key TEXT PRIMARY KEY,
    provider_id TEXT NOT NULL,
    confidence REAL NOT NULL,
    reason TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`)

  // The semantic judge's decisions. Its OWN table, not a second use of llm_rerank_cache: the two
  // ask different questions with different prompts and different key shapes, and versioning one
  // must never invalidate the other. The key already carries prompt version, model, ingredient
  // identity and the exact ordered candidate pool (see judge/candidate-pool.ts), so a row here can
  // only ever answer the question it was stored for. provider_id is the empty string for an
  // ambiguous or none verdict, which is cached like any other answer — it is a real judgement
  // about this candidate set, and re-asking would spend a call to be told the same thing.
  db.run(`CREATE TABLE IF NOT EXISTS llm_judge_cache (
    lookup_key TEXT PRIMARY KEY,
    verdict TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    confidence REAL NOT NULL,
    reason TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`)

  // One row per INGREDIENT classification, not per recipe batch, so two recipes sharing an
  // ingredient share its interpretation. Its own table and its own key version, deliberately
  // uncoupled from the BLS/USDA/OFF nutrition caches: what a food IS and what a database says
  // about it are different questions with different invalidation reasons.
  //
  // This exists because classification was measurably unstable. Ten consecutive estimates of one
  // unchanged recipe classified "300 g Nudeln" as cooked eight times and raw twice, moving the
  // recipe between 2004 and 2604 kcal. Sampling variance is now removed at the source
  // (temperature 0) and refused downstream (reconcileState); this makes the interpretation stick,
  // so a recipe re-estimated tomorrow reads its ingredients the same way it did today.
  db.run(`CREATE TABLE IF NOT EXISTS llm_classification_cache (
    lookup_key TEXT PRIMARY KEY,
    classification TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`)

  const now = Date.now()
  db.run("DELETE FROM llm_classification_cache WHERE updated_at < ?", [now - config.cache.llmTtlMs])
  db.run("DELETE FROM llm_judge_cache WHERE updated_at < ?", [now - config.cache.llmTtlMs])
  db.run("DELETE FROM provider_match_cache WHERE updated_at < ?", [now - config.cache.matchTtlMs])
  db.run("DELETE FROM provider_miss_cache WHERE updated_at < ?", [now - config.cache.missTtlMs])
  db.run("DELETE FROM llm_estimate_cache WHERE updated_at < ?", [now - config.cache.llmTtlMs])
  db.run("DELETE FROM llm_nutrient_cache WHERE updated_at < ?", [now - config.cache.llmTtlMs])
  db.run("DELETE FROM llm_rerank_cache WHERE updated_at < ?", [now - config.cache.llmTtlMs])

  scheduleSave()
  isInitialized = true
}

export function normalizeKey(key: string): string {
  return normalizeIdentityText(key)
}

/** Builds the composite cache key for a provider query — food name + brand, so branded and generic lookups never share a cache slot. */
export function buildQueryKey(foodName: string, brand: string | null): string {
  return `${normalizeKey(foodName)}|${brand ? normalizeKey(brand) : ""}`
}

function isExpired(updatedAt: number, ttlMs: number): boolean {
  return Date.now() - updatedAt > ttlMs
}


/**
 * Provenance fields added after the cache table was designed. Kept as one JSON column rather than
 * a column each, so a further field costs no migration: the shape is read back defensively and an
 * unreadable value simply means "no provenance", never a broken cache entry.
 */
function serializeProvenance(match: ProviderMatch): string | null {
  const extra: Record<string, unknown> = {}
  if (match.llmReranked) extra.llmReranked = true
  if (match.rerankReason) extra.rerankReason = match.rerankReason
  if (match.unmetAttributes?.length) extra.unmetAttributes = match.unmetAttributes
  return Object.keys(extra).length > 0 ? JSON.stringify(extra) : null
}

function parseProvenance(raw: unknown): Partial<ProviderMatch> {
  if (typeof raw !== "string" || raw.length === 0) return {}
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return {
      ...(parsed.llmReranked === true ? { llmReranked: true } : {}),
      ...(typeof parsed.rerankReason === "string" ? { rerankReason: parsed.rerankReason } : {}),
      ...(Array.isArray(parsed.unmetAttributes) ? { unmetAttributes: parsed.unmetAttributes.map(String) } : {}),
    }
  } catch {
    return {}
  }
}

export function getCachedProviderMatch(provider: string, queryKey: string): ProviderMatch | undefined {
  const stmt = db.prepare(
    // `provenance` MUST stay in this list. It was added to the table, the write, the row type and
    // the read-back call — but not here, so row.provenance was always undefined and every cached
    // match came back claiming it had never been reranked. Visible in production as
    // matchReason "llm-reranked" alongside llmReranked false.
    "SELECT canonical_name, brand, state, provider_id, product_name, confidence, nutrients, updated_at, data_type, food_type, match_reason, provenance FROM provider_match_cache WHERE provider = ? AND query_key = ?",
  )
  stmt.bind([provider, queryKey])
  try {
    if (!stmt.step()) return undefined
    const row = stmt.getAsObject() as {
      canonical_name: string
      brand: string | null
      state: string
      provider_id: string | null
      product_name: string | null
      confidence: number
      nutrients: string
      updated_at: number
      data_type: string | null
      food_type: string | null
      match_reason: string | null
      provenance?: string | null
    }
    if (isExpired(row.updated_at, config.cache.matchTtlMs)) {
      db.run("DELETE FROM provider_match_cache WHERE provider = ? AND query_key = ?", [provider, queryKey])
      scheduleSave()
      return undefined
    }
    return {
      nutrients: JSON.parse(row.nutrients) as NutrientSet,
      canonicalName: row.canonical_name,
      brand: row.brand,
      state: row.state as ProviderMatch["state"],
      provider,
      providerId: row.provider_id,
      productName: row.product_name,
      confidence: row.confidence,
      dataType: row.data_type,
      foodType: (row.food_type ?? undefined) as ProviderMatch["foodType"],
      matchReason: row.match_reason ?? undefined,
      ...parseProvenance(row.provenance),
    }
  } catch {
    return undefined
  } finally {
    stmt.free()
  }
}

export function setCachedProviderMatch(provider: string, queryKey: string, match: ProviderMatch): void {
  const now = Date.now()
  db.run(
    `INSERT INTO provider_match_cache
       (provider, query_key, canonical_name, brand, state, provider_id, product_name, confidence, nutrients, updated_at, data_type, food_type, match_reason, provenance)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(provider, query_key) DO UPDATE SET
       canonical_name = excluded.canonical_name,
       brand = excluded.brand,
       state = excluded.state,
       provider_id = excluded.provider_id,
       product_name = excluded.product_name,
       confidence = excluded.confidence,
       nutrients = excluded.nutrients,
       updated_at = excluded.updated_at,
       data_type = excluded.data_type,
       food_type = excluded.food_type,
       match_reason = excluded.match_reason,
       provenance = excluded.provenance`,
    [
      provider,
      queryKey,
      match.canonicalName,
      match.brand,
      match.state,
      match.providerId,
      match.productName,
      match.confidence,
      JSON.stringify(match.nutrients),
      now,
      match.dataType ?? null,
      match.foodType ?? null,
      match.matchReason ?? null,
      serializeProvenance(match),
    ],
  )
  scheduleSave()
}

export function isProviderMiss(provider: string, queryKey: string): boolean {
  const stmt = db.prepare("SELECT updated_at FROM provider_miss_cache WHERE provider = ? AND query_key = ?")
  stmt.bind([provider, queryKey])
  try {
    if (!stmt.step()) return false
    const row = stmt.getAsObject() as { updated_at: number }
    if (isExpired(row.updated_at, config.cache.missTtlMs)) {
      db.run("DELETE FROM provider_miss_cache WHERE provider = ? AND query_key = ?", [provider, queryKey])
      scheduleSave()
      return false
    }
    return true
  } finally {
    stmt.free()
  }
}

export function markProviderMiss(provider: string, queryKey: string): void {
  const now = Date.now()
  db.run(
    `INSERT INTO provider_miss_cache (provider, query_key, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(provider, query_key) DO UPDATE SET updated_at = excluded.updated_at`,
    [provider, queryKey, now],
  )
  scheduleSave()
}

/**
 * v2: volume units (ml/l) now cache a food-specific DENSITY in g/ml under one shared unit key
 * instead of grams-per-one-unit per unit name. Pre-v2 rows hold values on the old scale — and at
 * least one live row held a physically impossible 100 "grams per 1 ml", which is what turned
 * 750 ml of Gemuesebruehe into 75000 g on every run until it expired. Prefixing the key means
 * those rows are simply never matched again (no silent scale mismatch on upgrade) and they
 * self-expire via the normal TTL sweep. Bump this again if the value shape/units ever change.
 */
const LLM_ESTIMATE_CACHE_KEY_VERSION = "v2"

export function llmEstimateCacheKey(unitName: string, foodName: string): string {
  return `${LLM_ESTIMATE_CACHE_KEY_VERSION}:${normalizeKey(unitName)}|${normalizeKey(foodName)}`
}

export function getCachedLlmEstimate(unitName: string, foodName: string): number | undefined {
  const key = llmEstimateCacheKey(unitName, foodName)
  const stmt = db.prepare("SELECT grams, updated_at FROM llm_estimate_cache WHERE lookup_key = ?")
  stmt.bind([key])
  try {
    if (!stmt.step()) return undefined
    const row = stmt.getAsObject() as { grams: number; updated_at: number }
    if (isExpired(row.updated_at, config.cache.llmTtlMs)) {
      db.run("DELETE FROM llm_estimate_cache WHERE lookup_key = ?", [key])
      scheduleSave()
      return undefined
    }
    return row.grams
  } finally {
    stmt.free()
  }
}

export function setCachedLlmEstimate(unitName: string, foodName: string, grams: number): void {
  const key = llmEstimateCacheKey(unitName, foodName)
  const now = Date.now()
  db.run(
    `INSERT INTO llm_estimate_cache (lookup_key, grams, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(lookup_key) DO UPDATE SET grams = excluded.grams, updated_at = excluded.updated_at`,
    [key, grams, now],
  )
  scheduleSave()
}

/**
 * v2: the LLM nutrient prompt now explicitly requires sodium/cholesterol in grams (previously
 * ambiguous, which produced milligram-scale cached values). Prefixing the key means pre-v2 rows
 * are simply never matched again — no silent unit mismatch on upgrade — and they self-expire via
 * the normal TTL sweep. Bump this again if the value shape/units ever change.
 */
const LLM_NUTRIENT_CACHE_KEY_VERSION = "v2"

export function llmNutrientCacheKey(foodName: string): string {
  return `${LLM_NUTRIENT_CACHE_KEY_VERSION}:${normalizeKey(foodName)}`
}

export function getCachedLlmNutrients(foodName: string): NutrientSet | undefined {
  const key = llmNutrientCacheKey(foodName)
  const stmt = db.prepare("SELECT nutrients, updated_at FROM llm_nutrient_cache WHERE food_name = ?")
  stmt.bind([key])
  try {
    if (!stmt.step()) return undefined
    const row = stmt.getAsObject() as { nutrients: string; updated_at: number }
    if (isExpired(row.updated_at, config.cache.llmTtlMs)) {
      db.run("DELETE FROM llm_nutrient_cache WHERE food_name = ?", [key])
      scheduleSave()
      return undefined
    }
    return JSON.parse(row.nutrients) as NutrientSet
  } catch {
    return undefined
  } finally {
    stmt.free()
  }
}

export function setCachedLlmNutrients(foodName: string, nutrients: NutrientSet): void {
  const key = llmNutrientCacheKey(foodName)
  const now = Date.now()
  db.run(
    `INSERT INTO llm_nutrient_cache (food_name, nutrients, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(food_name) DO UPDATE SET nutrients = excluded.nutrients, updated_at = excluded.updated_at`,
    [key, JSON.stringify(nutrients), now],
  )
  scheduleSave()
}

export interface CachedRerank {
  providerId: string | null
  confidence: number
  reason: string
}

/** undefined = not cached (ask the model); a value = a cached verdict, possibly NONE. */
export function getCachedRerank(lookupKey: string): CachedRerank | undefined {
  const stmt = db.prepare("SELECT provider_id, confidence, reason, updated_at FROM llm_rerank_cache WHERE lookup_key = ?")
  try {
    stmt.bind([lookupKey])
    if (!stmt.step()) return undefined
    const row = stmt.getAsObject() as Record<string, unknown>
    if (isExpired(Number(row.updated_at), config.cache.llmTtlMs)) {
      db.run("DELETE FROM llm_rerank_cache WHERE lookup_key = ?", [lookupKey])
      scheduleSave()
      return undefined
    }
    const providerId = String(row.provider_id)
    return {
      providerId: providerId === "" ? null : providerId,
      confidence: Number(row.confidence),
      reason: String(row.reason ?? ""),
    }
  } finally {
    stmt.free()
  }
}

export function setCachedRerank(lookupKey: string, decision: CachedRerank): void {
  db.run(
    `INSERT INTO llm_rerank_cache (lookup_key, provider_id, confidence, reason, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(lookup_key) DO UPDATE SET provider_id = excluded.provider_id,
       confidence = excluded.confidence, reason = excluded.reason, updated_at = excluded.updated_at`,
    [lookupKey, decision.providerId ?? "", decision.confidence, decision.reason, Date.now()],
  )
  scheduleSave()
}

/**
 * A stored ingredient classification, as opaque JSON — cache.ts stays a leaf and does not need to
 * know the classification's shape. The caller owns the key (see llm-normalizer.ts), which is what
 * makes a prompt or model change invalidate these rows safely instead of silently reusing an
 * interpretation the current classifier would not produce.
 */
export function getCachedClassification(lookupKey: string): unknown | undefined {
  // Classification sits on the critical path for every recipe, so a cache that is not ready must
  // read as a miss rather than take estimation down with it.
  if (!isInitialized) return undefined
  const stmt = db.prepare("SELECT classification, updated_at FROM llm_classification_cache WHERE lookup_key = ?")
  try {
    stmt.bind([lookupKey])
    if (!stmt.step()) return undefined
    const row = stmt.getAsObject() as Record<string, unknown>
    if (isExpired(Number(row.updated_at), config.cache.llmTtlMs)) {
      db.run("DELETE FROM llm_classification_cache WHERE lookup_key = ?", [lookupKey])
      scheduleSave()
      return undefined
    }
    try {
      return JSON.parse(String(row.classification))
    } catch {
      // A row we cannot parse is a row we cannot trust: drop it and re-classify.
      db.run("DELETE FROM llm_classification_cache WHERE lookup_key = ?", [lookupKey])
      scheduleSave()
      return undefined
    }
  } finally {
    stmt.free()
  }
}

export function setCachedClassification(lookupKey: string, classification: unknown): void {
  if (!isInitialized) return
  db.run(
    `INSERT INTO llm_classification_cache (lookup_key, classification, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(lookup_key) DO UPDATE SET classification = excluded.classification, updated_at = excluded.updated_at`,
    [lookupKey, JSON.stringify(classification), Date.now()],
  )
  scheduleSave()
}

/** One stored judge verdict. Mirrors JudgeDecision without importing it, so cache.ts stays a leaf. */
export interface CachedJudgeDecision {
  verdict: "selected" | "ambiguous" | "none"
  candidateId: string | null
  confidence: number
  reason: string
}

/** undefined = not cached (ask the judge); a value = a stored verdict, possibly ambiguous/none. */
export function getCachedJudgeDecision(lookupKey: string): CachedJudgeDecision | undefined {
  const stmt = db.prepare("SELECT verdict, provider_id, confidence, reason, updated_at FROM llm_judge_cache WHERE lookup_key = ?")
  try {
    stmt.bind([lookupKey])
    if (!stmt.step()) return undefined
    const row = stmt.getAsObject() as Record<string, unknown>
    if (isExpired(Number(row.updated_at), config.cache.llmTtlMs)) {
      db.run("DELETE FROM llm_judge_cache WHERE lookup_key = ?", [lookupKey])
      scheduleSave()
      return undefined
    }
    const verdict = String(row.verdict)
    if (verdict !== "selected" && verdict !== "ambiguous" && verdict !== "none") return undefined
    const candidateId = String(row.provider_id)
    return {
      verdict,
      candidateId: candidateId === "" ? null : candidateId,
      confidence: Number(row.confidence),
      reason: String(row.reason ?? ""),
    }
  } finally {
    stmt.free()
  }
}

export function setCachedJudgeDecision(lookupKey: string, decision: CachedJudgeDecision): void {
  db.run(
    `INSERT INTO llm_judge_cache (lookup_key, verdict, provider_id, confidence, reason, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(lookup_key) DO UPDATE SET verdict = excluded.verdict, provider_id = excluded.provider_id,
       confidence = excluded.confidence, reason = excluded.reason, updated_at = excluded.updated_at`,
    [lookupKey, decision.verdict, decision.candidateId ?? "", decision.confidence, decision.reason, Date.now()],
  )
  scheduleSave()
}

/**
 * Test seam: drops the provider match/miss caches. Production never calls this — entries expire
 * through the normal TTL sweep — but a test that exercises the same ingredient under two different
 * configurations would otherwise be served its own earlier answer.
 */
export function __clearProviderCachesForTests(): void {
  db.run("DELETE FROM provider_match_cache")
  db.run("DELETE FROM provider_miss_cache")
  scheduleSave()
}

export function clearLlmCache(): void {
  db.run("DELETE FROM llm_estimate_cache")
  db.run("DELETE FROM llm_rerank_cache")
  db.run("DELETE FROM llm_judge_cache")
  db.run("DELETE FROM llm_classification_cache")
  db.run("DELETE FROM llm_nutrient_cache")
  scheduleSave()
}

export function getCacheStats(): {
  providerMatches: number
  providerMisses: number
  llmEstimates: number
  llmNutrients: number
} {
  const count = (table: string): number => {
    const stmt = db.prepare(`SELECT COUNT(*) as cnt FROM ${table}`)
    try {
      stmt.step()
      return (stmt.getAsObject() as { cnt: number }).cnt
    } finally {
      stmt.free()
    }
  }

  return {
    providerMatches: count("provider_match_cache"),
    providerMisses: count("provider_miss_cache"),
    llmEstimates: count("llm_estimate_cache"),
    llmNutrients: count("llm_nutrient_cache"),
  }
}
