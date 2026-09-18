import { describe, it, expect, beforeAll } from "vitest"
import initSqlJs from "sql.js"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { normalizeGermanText } from "../src/utils/text-normalize.js"
import { germanTokenMatches, PLURAL_ENDINGS } from "../src/services/providers/food-semantics.js"

/**
 * Recall searched BLS by raw substring containment on the core's own surface form, with no
 * morphology, so a German plural core could not reach BLS's singular compounds. The table stores
 * "Kidneybohne reif"; a core of "Bohnen" matched none of the kidney/garden/lima/mung family, and
 * the bean recall pool was 46 records of which 37 were composite dishes and not one was a plain
 * bean. Nothing downstream could recover from that: retrieval runs before scoring and reranking.
 *
 * These assertions run against the real bundled 7,140-row table rather than fixtures, because the
 * whole defect is about what that specific table happens to contain. They mirror recallNeedles()
 * exactly — it is not exported, and exporting it only to test it would widen the module's surface
 * for no gain.
 *
 * Every case here was measured during the investigation, including the ones that killed rival
 * strategies. They are locked in so a later "simplification" cannot quietly reintroduce them.
 */

const MIN_RECALL_CORE_LENGTH = 4
const MIN_DERIVED_NEEDLE_LENGTH = 5
const MAX_RECALL_HITS = 120

function recallNeedles(core: string): string[] {
  const base = normalizeGermanText(core).replace(/[^\p{L}\p{N}]/gu, "")
  if (base.length < MIN_RECALL_CORE_LENGTH) return []
  const derived = new Set<string>()
  for (const ending of PLURAL_ENDINGS) {
    if (base.endsWith(ending) && base.length - ending.length >= MIN_DERIVED_NEEDLE_LENGTH) {
      derived.add(base.slice(0, -ending.length))
    }
    derived.add(base + ending)
  }
  return [base, ...[...derived].filter((v) =>
    v !== base && v.length >= MIN_DERIVED_NEEDLE_LENGTH && germanTokenMatches(v, base))]
}

let records: { code: string; name: string; norm: string }[] = []

const rawHits = (core: string): typeof records => {
  const needles = recallNeedles(core)
  if (needles.length === 0) return []
  return records.filter((r) => needles.some((n) => r.norm.includes(n)))
}
/** What recall searched for before this change: the base needle alone. */
const baselineHits = (core: string): typeof records => {
  const base = normalizeGermanText(core).replace(/[^\p{L}\p{N}]/gu, "")
  if (base.length < MIN_RECALL_CORE_LENGTH) return []
  return records.filter((r) => r.norm.includes(base))
}

beforeAll(async () => {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const SQL = await initSqlJs()
  const db = new SQL.Database(fs.readFileSync(path.join(here, "../resources/bls/bls-4.0.sqlite")))
  records = db.exec("select bls_code, name_de, name_de_normalized from bls_foods")[0].values
    .map(([code, name, norm]) => ({ code: String(code), name: String(name), norm: String(norm) }))
  db.close()
  expect(records.length).toBeGreaterThan(7000)
})

describe("a plural core reaches the singular compound records", () => {
  it("the bean family becomes reachable, and the pool stops being mostly composite dishes", () => {
    expect(baselineHits("Bohnen")).toHaveLength(46)
    expect(rawHits("Bohnen")).toHaveLength(94)

    const after = new Set(rawHits("Bohnen").map((r) => r.code))
    const before = new Set(baselineHits("Bohnen").map((r) => r.code))
    // The records the resolver could not see at all. Green AND dry AND canned: this fixes
    // reachability, it does not decide which one an unqualified "Bohnen" means.
    for (const code of ["G710100", "H742100", "H742132", "H742902", "H739400"]) {
      expect(before.has(code), `${code} was expected to be unreachable before`).toBe(false)
      expect(after.has(code), `${code} must be reachable now`).toBe(true)
    }
  })

  it("other plural cores gain their singular records too", () => {
    // Not a bean special case — every plural core had the same hole.
    for (const [core, before, after] of [["Zwiebeln", 35, 81], ["Linsen", 25, 30], ["Kichererbsen", 9, 12]] as const) {
      expect(baselineHits(core), core).toHaveLength(before)
      expect(rawHits(core), core).toHaveLength(after)
    }
  })
})

describe("the cap is still measured on raw hits, and no working core may cross it", () => {
  it("a core already over the cap is unchanged in effect, and is not claimed as a fix", () => {
    // "Tomaten" has 124 raw hits TODAY, already above the cap, so recall returns [] and has always
    // done so. Widening takes it to 143 — still []. G561100 "Tomate roh" does NOT become reachable.
    expect(baselineHits("Tomaten").length).toBe(124)
    expect(rawHits("Tomaten").length).toBe(143)
    expect(baselineHits("Tomaten").length).toBeGreaterThan(MAX_RECALL_HITS)
    expect(rawHits("Tomaten").length).toBeGreaterThan(MAX_RECALL_HITS)
  })

  it("no core in the real corpus goes from under the cap to over it", () => {
    for (const r of records) {
      const before = baselineHits(r.name).length
      if (before === 0 || before > MAX_RECALL_HITS) continue
      expect(rawHits(r.name).length, `"${r.name}" would lose recall entirely`).toBeLessThanOrEqual(MAX_RECALL_HITS)
    }
  })
})

describe("the base needle is never sacrificed to the length floor", () => {
  it("a four-letter core keeps exactly the recall it had", () => {
    // The floor applies to DERIVED variants only. An earlier revision applied it to the base too,
    // which silently emptied recall for Mehl, Salz, Feta, Wein, Reis, Brot, Rind, Hefe and Zimt.
    for (const core of ["Mehl", "Salz", "Feta", "Wein", "Reis", "Brot", "Rind", "Hefe", "Zimt"]) {
      const before = baselineHits(core).length
      expect(before, core).toBeGreaterThan(0)
      expect(rawHits(core).length, core).toBeGreaterThanOrEqual(before)
      expect(recallNeedles(core)[0], core).toBe(normalizeGermanText(core))
    }
  })

  it("a core below the existing minimum still yields no needles at all", () => {
    expect(recallNeedles("Ei")).toEqual([])
    expect(recallNeedles("Öl")).toEqual([])
  })
})

describe("short stems never become needles", () => {
  it("'Minze' does not acquire 'minz' and cannot reach Pfefferminz products", () => {
    expect(recallNeedles("Minze")).not.toContain("minz")

    const reached = rawHits("Minze").map((r) => r.name)
    expect(reached.filter((n) => /pfefferminz/i.test(n))).toHaveLength(0)
    // It had no recall before and gains none: a false positive is not an improvement.
    expect(rawHits("Minze")).toHaveLength(baselineHits("Minze").length)
  })
})

describe("nothing currently reachable is lost", () => {
  it("'Hähnchenbrust' keeps its raw-hit set", () => {
    // A token-matching strategy was measured taking this from 13 hits to 0 by dropping compound
    // substring hits. Needle-additive matching cannot do that, and this asserts it.
    const before = baselineHits("Hähnchenbrust")
    expect(before.length).toBe(13)
    const after = new Set(rawHits("Hähnchenbrust").map((r) => r.code))
    for (const r of before) expect(after.has(r.code), r.name).toBe(true)
  })

  it("every record name in the table yields a superset of its previous pool", () => {
    // The strongest form of "additive": run it over all 7,140 names, not a chosen sample.
    for (const r of records) {
      const before = baselineHits(r.name)
      if (before.length === 0) continue
      const after = new Set(rawHits(r.name).map((x) => x.code))
      expect(before.every((b) => after.has(b.code)), `"${r.name}" lost records`).toBe(true)
    }
  })
})
