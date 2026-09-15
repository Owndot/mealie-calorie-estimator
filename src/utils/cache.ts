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

  const now = Date.now()
  db.run("DELETE FROM provider_match_cache WHERE updated_at < ?", [now - config.cache.matchTtlMs])
  db.run("DELETE FROM provider_miss_cache WHERE updated_at < ?", [now - config.cache.missTtlMs])
  db.run("DELETE FROM llm_estimate_cache WHERE updated_at < ?", [now - config.cache.llmTtlMs])
  db.run("DELETE FROM llm_nutrient_cache WHERE updated_at < ?", [now - config.cache.llmTtlMs])

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

export function getCachedProviderMatch(provider: string, queryKey: string): ProviderMatch | undefined {
  const stmt = db.prepare(
    "SELECT canonical_name, brand, state, provider_id, product_name, confidence, nutrients, updated_at, data_type, food_type, match_reason FROM provider_match_cache WHERE provider = ? AND query_key = ?",
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
       (provider, query_key, canonical_name, brand, state, provider_id, product_name, confidence, nutrients, updated_at, data_type, food_type, match_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
       match_reason = excluded.match_reason`,
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

export function clearLlmCache(): void {
  db.run("DELETE FROM llm_estimate_cache")
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
