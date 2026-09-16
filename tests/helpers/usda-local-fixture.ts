import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import initSqlJs from "sql.js"
import { config } from "../../src/config.js"
import { __resetUsdaLocalForTests } from "../../src/services/providers/usda-local-provider.js"

/**
 * Builds a throwaway USDA-local database and points the provider at it.
 *
 * This replaces the old `mockUsdaProvider`, which stubbed `fetch` to answer FoodData Central
 * search requests. There is no fetch to stub any more — USDA is a bundled file — so a test that
 * needs a controlled USDA record has to supply a controlled DATABASE. The provider then runs its
 * real load, retrieval, ranking and gating over it, which is the point: the seam moved down a
 * layer rather than disappearing.
 *
 * Use this for behaviour that needs a small, fully-known corpus. For "does the real bundled data
 * contain and expose X", use the bundled database directly instead (see usda-local-provider tests)
 * — that is the question the live API could not answer honestly.
 */

export interface UsdaTestFood {
  fdcId?: number
  description: string
  dataType?: "SR Legacy" | "Foundation"
  category?: string | null
  /** Which FoodData Central nutrient id supplied kcal, for provenance fidelity. */
  energyNutrientId?: number
  kcal: number
  protein?: number
  carbs?: number
  fat?: number
  saturatedFat?: number
  transFat?: number
  fiber?: number
  sugar?: number
  /** GRAMS per 100 g, already converted — the importer does the mg -> g step, not the provider. */
  sodium?: number
  cholesterol?: number
}

const FIELDS = ["kcal", "protein", "carbs", "fat", "saturated_fat", "trans_fat", "fiber", "sugar", "sodium", "cholesterol"] as const

/** Must match scripts/import_usda.py's normalize() exactly, or retrieval behaves differently here. */
export function normalizeDescription(text: string): string {
  const folded = text.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "")
  return folded.replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim()
}

const created: string[] = []
let nextId = 900000

/** Writes a USDA-local database containing exactly `foods` and points config at it. */
export async function useUsdaLocalFixture(foods: UsdaTestFood[]): Promise<string> {
  const SQL = await initSqlJs()
  const db = new SQL.Database()
  db.run(`CREATE TABLE usda_foods (
    fdc_id INTEGER PRIMARY KEY, data_type TEXT NOT NULL, description TEXT NOT NULL,
    description_normalized TEXT NOT NULL, category TEXT, energy_nutrient_id INTEGER,
    ${FIELDS.map((f) => `${f} REAL`).join(", ")})`)
  db.run("CREATE TABLE usda_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
  // schema_version must match the provider's SUPPORTED_SCHEMA_VERSION or it refuses the file —
  // which is itself covered by a test.
  db.run("INSERT INTO usda_meta (key, value) VALUES ('schema_version', '1'), ('datasets', 'test fixture')")

  for (const f of foods) {
    db.run(
      `INSERT INTO usda_foods VALUES (?,?,?,?,?,?,${FIELDS.map(() => "?").join(",")})`,
      [
        f.fdcId ?? nextId++, f.dataType ?? "SR Legacy", f.description,
        normalizeDescription(f.description), f.category ?? null, f.energyNutrientId ?? 1008,
        f.kcal, f.protein ?? null, f.carbs ?? null, f.fat ?? null, f.saturatedFat ?? null,
        f.transFat ?? null, f.fiber ?? null, f.sugar ?? null, f.sodium ?? null, f.cholesterol ?? null,
      ] as (string | number | null)[],
    )
  }

  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "usda-fixture-")), "usda-generic.sqlite")
  fs.writeFileSync(file, Buffer.from(db.export()))
  db.close()
  created.push(file)

  config.usdaLocal.dbPath = file
  __resetUsdaLocalForTests()
  return file
}

/** Restores the bundled database and removes anything this helper wrote. */
export function resetUsdaLocalFixture(): void {
  config.usdaLocal.dbPath = ""
  __resetUsdaLocalForTests()
  for (const file of created.splice(0)) {
    fs.rmSync(path.dirname(file), { recursive: true, force: true })
  }
}

/** A database with no rows at all — "USDA has nothing for this", without touching the network. */
export function useEmptyUsdaLocal(): Promise<string> {
  return useUsdaLocalFixture([])
}
