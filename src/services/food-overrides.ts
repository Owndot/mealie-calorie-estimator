import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import initSqlJs, { type Database } from "sql.js"
import { config } from "../config.js"
import { logger } from "../utils/logger.js"
import { normalizeIdentityText } from "../utils/text-normalize.js"
import type { FoodAttributes } from "../types.js"

/**
 * USER-CONFIRMED FOOD OVERRIDES.
 *
 * The automatic chain deliberately refuses to guess: shown a dozen mince records and asked which
 * one is "mager", the semantic judge answers AMBIGUOUS, and the recipe keeps an ordinary record
 * with `unmetAttributes: ["reduced-fat"]`. That is the right machine answer and a permanently
 * wrong recipe. This is the other half: a person decides once, and the decision persists.
 *
 * An override is a POINTER, never a copy. It records which real record was chosen; the nutrients
 * are reloaded from that provider every time. Nothing here can turn into a stored nutrient value,
 * and a target that cannot be loaded falls back to the ordinary resolver rather than serving
 * something stale under the override's name.
 *
 * Its own database file, not the cache: this is durable user data, and `data/cache.db` is
 * TTL-swept, has a clear-all for tests, and is the file someone would delete to reset bad matches.
 */

/**
 * Key shape version. A change here means the SEMANTICS of the key changed, so old rows are NOT
 * silently re-targeted — they stop matching, are reported as stale by the management API, and a
 * person re-binds them. Re-pointing a stored decision at a key it was never made for would be
 * exactly the kind of silent wrongness this system exists to remove.
 */
export const OVERRIDE_KEY_VERSION = "ov1"

export interface OverrideIdentity {
  canonicalEnglish: string
  state: string
  attributes: FoodAttributes
  /**
   * A brand ONLY when the ingredient text itself named one. ProviderQuery.brand is already
   * evidence-verified upstream (verifyBrandEvidence keeps it only when it appears in the
   * structured food name), so passing it straight through is what "explicit brand" means.
   */
  brand: string | null
}

/**
 * The durable identity of an INGREDIENT — what was written and what it means — and nothing about
 * how the resolver happens to handle it.
 *
 * `route` is deliberately absent: it is a resolver implementation detail, and an override must
 * survive a routing change. The TARGET record's provider and brand are likewise absent: binding
 * "Rinderhackfleisch mager" to an Edeka product must not make "Edeka" part of what the ingredient
 * IS. `coreFoodEnglish` is absent too — it is a lossy projection of canonicalEnglish (measured:
 * the classifier reports "mayo" where USDA files "mayonnaise"), so keying on it would make
 * overrides fragile without discriminating anything.
 *
 * Failure is safe by construction: classifier drift makes the key MISS, and normal resolution
 * runs. There is no fuzzy or substring fallback, so an override can never reach a food it was not
 * made for.
 */
export function buildOverrideKey(identity: OverrideIdentity): string {
  const a = identity.attributes
  return [
    OVERRIDE_KEY_VERSION,
    normalizeIdentityText(identity.canonicalEnglish),
    identity.state,
    a.form,
    a.preservation,
    a.fatPercent ?? "-",
    identity.brand ? normalizeIdentityText(identity.brand) : "-",
  ].join("|")
}

/**
 * A short, stable, URL-safe handle for the key. Management addresses overrides by this, so no
 * caller has to correctly encode a long "ov1|…" string containing spaces and separators, and the
 * key shape stays free to evolve without breaking anyone's bookmarks or scripts.
 */
export function overrideId(overrideKey: string): string {
  return createHash("sha256").update(overrideKey).digest("hex").slice(0, 16)
}

export type OverrideProvider = "bls" | "usda-local" | "off" | "mealie-recipe"

export interface FoodOverride {
  id: string
  overrideKey: string
  keyVersion: string
  /** The structured ingredient text that prompted this binding — audit and readability. */
  exampleName: string
  canonicalEnglish: string
  state: string
  form: string
  preservation: string
  fatPercent: number | null
  brand: string | null
  provider: OverrideProvider
  providerId: string
  /** The target's name WHEN BOUND. Audit only — never used as, or instead of, nutrition data. */
  recordName: string
  source: string
  note: string | null
  createdAt: number
  updatedAt: number
}

let db: Database | undefined
let saveTimer: ReturnType<typeof setTimeout> | null = null

function persist(): void {
  try {
    const dir = path.dirname(config.overrides.dbPath)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(config.overrides.dbPath, Buffer.from(db!.export()))
  } catch (err) {
    logger.error({ err }, "Failed to save the food-override database")
  }
}

/** Overrides are written rarely and must not be lost; the debounce is short and always flushed. */
function scheduleSave(): void {
  if (saveTimer) return
  saveTimer = setTimeout(() => { saveTimer = null; persist() }, 250)
}

export function flushOverrides(): void {
  if (!saveTimer) return
  clearTimeout(saveTimer)
  saveTimer = null
  persist()
}

export async function initOverrides(): Promise<void> {
  if (db) return
  const dbPath = config.overrides.dbPath
  const dir = path.dirname(dbPath)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })

  const SQL = await initSqlJs()
  // An absent file is not an error: it is a deployment with no overrides, which must behave
  // exactly as this service did before overrides existed.
  db = fs.existsSync(dbPath) ? new SQL.Database(fs.readFileSync(dbPath)) : new SQL.Database()

  db.run(`CREATE TABLE IF NOT EXISTS food_overrides (
    id            TEXT PRIMARY KEY,
    override_key  TEXT NOT NULL UNIQUE,
    key_version   TEXT NOT NULL,
    example_name  TEXT NOT NULL,
    canonical_en  TEXT NOT NULL,
    state         TEXT NOT NULL,
    form          TEXT NOT NULL,
    preservation  TEXT NOT NULL,
    fat_percent   REAL,
    brand         TEXT,
    provider      TEXT NOT NULL,
    provider_id   TEXT NOT NULL,
    record_name   TEXT NOT NULL,
    source        TEXT NOT NULL,
    note          TEXT,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
  )`)
  db.run("CREATE INDEX IF NOT EXISTS idx_food_overrides_target ON food_overrides (provider, provider_id)")

  const count = countOverrides()
  logger.info({ dbPath, overrides: count }, "Loaded user-confirmed food overrides")
}

/** True once the store is ready. Resolution treats "not ready" as "no overrides". */
export function overridesReady(): boolean {
  return db !== undefined
}

function rowToOverride(r: Record<string, unknown>): FoodOverride {
  return {
    id: String(r.id),
    overrideKey: String(r.override_key),
    keyVersion: String(r.key_version),
    exampleName: String(r.example_name),
    canonicalEnglish: String(r.canonical_en),
    state: String(r.state),
    form: String(r.form),
    preservation: String(r.preservation),
    fatPercent: r.fat_percent === null || r.fat_percent === undefined ? null : Number(r.fat_percent),
    brand: r.brand === null || r.brand === undefined ? null : String(r.brand),
    provider: String(r.provider) as OverrideProvider,
    providerId: String(r.provider_id),
    recordName: String(r.record_name),
    source: String(r.source),
    note: r.note === null || r.note === undefined ? null : String(r.note),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  }
}

function queryAll(sql: string, params: (string | number | null)[] = []): FoodOverride[] {
  if (!db) return []
  const stmt = db.prepare(sql)
  try {
    stmt.bind(params)
    const out: FoodOverride[] = []
    while (stmt.step()) out.push(rowToOverride(stmt.getAsObject() as Record<string, unknown>))
    return out
  } finally {
    stmt.free()
  }
}

export function countOverrides(): number {
  return queryAll("SELECT * FROM food_overrides").length
}

export function listOverrides(): FoodOverride[] {
  return queryAll("SELECT * FROM food_overrides ORDER BY updated_at DESC")
}

export function getOverrideById(id: string): FoodOverride | undefined {
  return queryAll("SELECT * FROM food_overrides WHERE id = ?", [id])[0]
}

/**
 * The matching entry point. Only an EXACT key match counts, and only for the current key version:
 * a row written under an older shape describes an identity this code no longer computes, so it is
 * not applied.
 */
export function findOverride(identity: OverrideIdentity): FoodOverride | undefined {
  if (!db) return undefined
  const key = buildOverrideKey(identity)
  const row = queryAll("SELECT * FROM food_overrides WHERE override_key = ?", [key])[0]
  return row && row.keyVersion === OVERRIDE_KEY_VERSION ? row : undefined
}

export interface SetOverrideInput {
  identity: OverrideIdentity
  exampleName: string
  provider: OverrideProvider
  providerId: string
  recordName: string
  note?: string | null
}

export function setOverride(input: SetOverrideInput): FoodOverride {
  const overrideKey = buildOverrideKey(input.identity)
  const id = overrideId(overrideKey)
  const now = Date.now()
  const existing = getOverrideById(id)
  const a = input.identity.attributes

  db!.run(
    `INSERT INTO food_overrides
       (id, override_key, key_version, example_name, canonical_en, state, form, preservation,
        fat_percent, brand, provider, provider_id, record_name, source, note, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       override_key = excluded.override_key, key_version = excluded.key_version,
       example_name = excluded.example_name, canonical_en = excluded.canonical_en,
       state = excluded.state, form = excluded.form, preservation = excluded.preservation,
       fat_percent = excluded.fat_percent, brand = excluded.brand,
       provider = excluded.provider, provider_id = excluded.provider_id,
       record_name = excluded.record_name, note = excluded.note, updated_at = excluded.updated_at`,
    [
      id, overrideKey, OVERRIDE_KEY_VERSION, input.exampleName,
      input.identity.canonicalEnglish, input.identity.state, a.form, a.preservation,
      a.fatPercent ?? null, input.identity.brand ?? null,
      input.provider, input.providerId, input.recordName, "user-confirmed",
      input.note ?? null, existing?.createdAt ?? now, now,
    ],
  )
  scheduleSave()
  flushOverrides()
  return getOverrideById(id)!
}

export function deleteOverride(id: string): boolean {
  const existing = getOverrideById(id)
  if (!existing) return false
  db!.run("DELETE FROM food_overrides WHERE id = ?", [id])
  scheduleSave()
  flushOverrides()
  return true
}

/** Test seam: a fresh in-memory store. */
export async function __resetOverridesForTests(): Promise<void> {
  db = undefined
  await initOverrides()
  db!.run("DELETE FROM food_overrides")
}
