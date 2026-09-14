import initSqlJs, { type Database } from "sql.js"
import fs from "node:fs"
import path from "node:path"
import { config } from "../config.js"
import type { NutrientSet, ProviderMatch } from "../types.js"
import { logger } from "./logger.js"

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
    PRIMARY KEY (provider, query_key)
  )`)

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
  return key.toLowerCase().trim()
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
    "SELECT canonical_name, brand, state, provider_id, product_name, confidence, nutrients, updated_at FROM provider_match_cache WHERE provider = ? AND query_key = ?",
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
       (provider, query_key, canonical_name, brand, state, provider_id, product_name, confidence, nutrients, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(provider, query_key) DO UPDATE SET
       canonical_name = excluded.canonical_name,
       brand = excluded.brand,
       state = excluded.state,
       provider_id = excluded.provider_id,
       product_name = excluded.product_name,
       confidence = excluded.confidence,
       nutrients = excluded.nutrients,
       updated_at = excluded.updated_at`,
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

export function getCachedLlmEstimate(unitName: string, foodName: string): number | undefined {
  const key = `${normalizeKey(unitName)}|${normalizeKey(foodName)}`
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
  const key = `${normalizeKey(unitName)}|${normalizeKey(foodName)}`
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
