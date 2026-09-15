import { describe, it, expect } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { normalizeGermanText, normalizeIdentityText } from "../src/utils/text-normalize.js"

// Found live: ranking.ts's tokenize() and (separately) cache.ts's normalizeKey() both used
// Unicode NFKD normalization to handle umlauts, which decomposes "ö" into "o" + a combining
// diaeresis (U+0308) — that combining mark then gets silently stripped by whatever char-class
// filtering runs next, corrupting "Gewürz" into two garbage fragments ["gewu", "rz"] instead of
// one token. Separately, scripts/import_bls.py's normalize_name() had the identical bug on the
// Python side, and — since it never agreed with the JS-side normalizeKey() to begin with (the JS
// side didn't even attempt NFKD) — BLS's own exact-match dictionary had been silently unable to
// find any German food name containing an umlaut this entire session, always falling through to
// (weaker) fuzzy matching instead.
describe("normalizeGermanText — deterministic umlaut/ß transliteration, not NFKD", () => {
  it("transliterates ä/ö/ü/ß to the standard ae/oe/ue/ss digraphs", () => {
    expect(normalizeGermanText("Gewürz")).toBe("gewuerz")
    expect(normalizeGermanText("Öl")).toBe("oel")
    expect(normalizeGermanText("grüne")).toBe("gruene")
    expect(normalizeGermanText("Frühlingszwiebel")).toBe("fruehlingszwiebel")
    expect(normalizeGermanText("Hähnchen")).toBe("haehnchen")
    expect(normalizeGermanText("Käse")).toBe("kaese")
    expect(normalizeGermanText("Straße")).toBe("strasse")
  })

  it("never produces the lossy ä->a / ö->o / ü->u collapse", () => {
    expect(normalizeGermanText("Öl")).not.toBe("ol")
    expect(normalizeGermanText("Käse")).not.toBe("kase")
    expect(normalizeGermanText("Gewürz")).not.toBe("gewurz")
  })

  it("never leaves a garbage fragment the way NFKD-then-strip did", () => {
    for (const word of ["Gewürz", "Öl", "grüne", "Frühlingszwiebel", "Hähnchen", "Käse"]) {
      const result = normalizeGermanText(word)
      expect(result).not.toContain(" ") // a single word must normalize to a single unbroken run
      expect(result.length).toBeGreaterThan(2)
    }
  })
})

describe("normalizeIdentityText — full exact-match/cache-key form", () => {
  it("collapses punctuation/commas to single spaces after transliteration", () => {
    expect(normalizeIdentityText("Kartoffel, geschält, roh")).toBe("kartoffel geschaelt roh")
  })

  it("matches the Python-side scripts/import_bls.py normalize_name() output exactly for every regression word", () => {
    // These values were cross-checked directly against a Python run of the (now-fixed)
    // normalize_name() — see the import_bls.py docstring. This is the load-bearing contract for
    // BLS's exact-match dictionary: a query-time normalizeKey() call must produce the same string
    // as whatever was precomputed into name_de_normalized at import time.
    expect(normalizeIdentityText("Käse")).toBe("kaese")
    expect(normalizeIdentityText("Gewürz")).toBe("gewuerz")
    expect(normalizeIdentityText("Öl")).toBe("oel")
    expect(normalizeIdentityText("grüne")).toBe("gruene")
    expect(normalizeIdentityText("Frühlingszwiebel")).toBe("fruehlingszwiebel")
    expect(normalizeIdentityText("Hähnchen")).toBe("haehnchen")
    expect(normalizeIdentityText("Speisezwiebel")).toBe("speisezwiebel")
  })
})

describe("cross-language normalization contract: scripts/import_bls.py vs normalizeIdentityText", () => {
  // The BLS exact-match dictionary is keyed by `name_de_normalized`, computed in PYTHON at import
  // time, and looked up with normalizeKey() -> normalizeIdentityText() in TYPESCRIPT at query
  // time. The two implementations are hand-duplicated and can only be kept in sync by hand, and
  // when they silently diverged before, BLS's exact-match path stopped finding ANY German food
  // name containing an umlaut for the entire project — falling back to weaker fuzzy matching with
  // no error anywhere. Sample-based assertions did not catch that, so this checks every row.
  it("every stored name_de_normalized in the bundled BLS database matches the TS implementation", async () => {
    const initSqlJs = (await import("sql.js")).default
    const SQL = await initSqlJs()
    const dbPath = path.join(process.cwd(), "resources/bls/bls-4.0.sqlite")
    const db = new SQL.Database(fs.readFileSync(dbPath))

    const stmt = db.prepare("SELECT name_de, name_de_normalized FROM bls_foods")
    const mismatches: { nameDe: string; stored: string; computed: string }[] = []
    let rows = 0
    try {
      while (stmt.step()) {
        const row = stmt.getAsObject() as { name_de: string; name_de_normalized: string }
        rows++
        const computed = normalizeIdentityText(row.name_de)
        if (computed !== row.name_de_normalized) {
          if (mismatches.length < 5) mismatches.push({ nameDe: row.name_de, stored: row.name_de_normalized, computed })
        }
      }
    } finally {
      stmt.free()
      db.close()
    }

    expect(rows).toBe(7140)
    expect(mismatches).toEqual([])
  })
})
