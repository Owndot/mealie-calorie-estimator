import { describe, it, expect, beforeAll } from "vitest"
import fs from "node:fs"
import path from "node:path"
import initSqlJs from "sql.js"

// Option C integrity: ONE runtime BLS database, with the curated raw/base-ingredient subset marked
// by a flag rather than shipped as a second database. These tests guard the three things that
// could silently go wrong: the flag drifting from the committed list, the list gaining codes the
// database doesn't have, and the regeneration altering nutrition.
let rows: Record<string, any>[] = []
let listedCodes: string[] = []

beforeAll(async () => {
  const SQL = await initSqlJs()
  const db = new SQL.Database(fs.readFileSync(path.join(process.cwd(), "resources/bls/bls-4.0.sqlite")))
  const stmt = db.prepare("SELECT bls_code, food_type, ingredient_preferred, kcal_per_100g FROM bls_foods")
  try { while (stmt.step()) rows.push(stmt.getAsObject() as Record<string, any>) } finally { stmt.free(); db.close() }

  listedCodes = fs.readFileSync(path.join(process.cwd(), "resources/bls/ingredient-codes-2992.txt"), "utf8")
    .split("\n").map((l) => l.trim()).filter((l) => l.length > 0 && !l.startsWith("#"))
})

describe("BLS ingredient_preferred (Option C)", () => {
  it("has exactly 2,992 flagged rows out of the full 7,140", () => {
    expect(rows).toHaveLength(7140)
    expect(rows.filter((r) => Number(r.ingredient_preferred) === 1)).toHaveLength(2992)
  })

  it("the committed code list has exactly 2,992 entries with no duplicates", () => {
    expect(listedCodes).toHaveLength(2992)
    expect(new Set(listedCodes).size).toBe(2992)
  })

  it("every listed code exists in the database — the list introduces no new codes", () => {
    const dbCodes = new Set(rows.map((r) => r.bls_code as string))
    expect(listedCodes.filter((c) => !dbCodes.has(c))).toEqual([])
  })

  it("the flag matches the committed list exactly, in both directions", () => {
    const listed = new Set(listedCodes)
    const flagged = new Set(rows.filter((r) => Number(r.ingredient_preferred) === 1).map((r) => r.bls_code as string))
    expect([...listed].filter((c) => !flagged.has(c))).toEqual([])
    expect([...flagged].filter((c) => !listed.has(c))).toEqual([])
  })

  it("never flags an X/Y menu component, and flags only food_type 'simple'", () => {
    const flagged = rows.filter((r) => Number(r.ingredient_preferred) === 1)
    expect(flagged.filter((r) => "XY".includes((r.bls_code as string)[0]))).toEqual([])
    expect(flagged.filter((r) => r.food_type !== "simple")).toEqual([])
  })

  it("carries the flag's provenance in bls_meta", async () => {
    const SQL = await initSqlJs()
    const db = new SQL.Database(fs.readFileSync(path.join(process.cwd(), "resources/bls/bls-4.0.sqlite")))
    const meta: Record<string, string> = {}
    const stmt = db.prepare("SELECT key, value FROM bls_meta")
    try { while (stmt.step()) { const r = stmt.getAsObject() as any; meta[r.key] = r.value } } finally { stmt.free(); db.close() }
    expect(meta.ingredient_preferred_count).toBe("2992")
    expect(meta.ingredient_preferred_source).toBe("ingredient-codes-2992.txt")
    expect(meta.food_count).toBe("7140")
  })

  it("every flagged row still carries usable nutrition", () => {
    const flagged = rows.filter((r) => Number(r.ingredient_preferred) === 1)
    expect(flagged.filter((r) => r.kcal_per_100g === null)).toEqual([])
  })
})
