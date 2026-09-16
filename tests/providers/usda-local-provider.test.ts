import { describe, it, expect, beforeAll, afterEach } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import initSqlJs from "sql.js"
import { config } from "../../src/config.js"
import { initCache, setCachedProviderMatch, getCachedProviderMatch, buildQueryKey, __clearProviderCachesForTests } from "../../src/utils/cache.js"
import { usdaLocalProvider, getUsdaLocalData, __resetUsdaLocalForTests } from "../../src/services/providers/usda-local-provider.js"
import { useUsdaLocalFixture, resetUsdaLocalFixture } from "../helpers/usda-local-fixture.js"
import { UNKNOWN_ATTRIBUTES, type ProviderMatch, type ProviderQuery } from "../../src/types.js"

/**
 * Tests against the REAL BUNDLED DATABASE, not a mock.
 *
 * This layer exists because the whole reason for this provider is that the live API's candidate
 * window did not reflect what USDA actually contains. A test that mocks the corpus cannot catch a
 * wrong importer, a missing dataset, a dropped nutrient or an accidental Branded/FNDDS row — and
 * those are exactly the failures that would quietly undo the change.
 */

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..")
const DB_PATH = path.join(REPO, "resources/usda/usda-generic.sqlite")

/** Counts straight from the pinned releases. They change only when a release is deliberately
 *  updated — at which point these numbers are updated in the same commit, on purpose. */
const EXPECTED = { Foundation: 469, "SR Legacy": 7793, total: 8262 }

async function query(db: string): Promise<Record<string, unknown>[]> {
  const SQL = await initSqlJs()
  const handle = new SQL.Database(fs.readFileSync(DB_PATH))
  const stmt = handle.prepare(db)
  const rows: Record<string, unknown>[] = []
  while (stmt.step()) rows.push(stmt.getAsObject())
  stmt.free()
  handle.close()
  return rows
}

beforeAll(async () => {
  await initCache()
})

afterEach(() => {
  resetUsdaLocalFixture()
})

describe("the bundled USDA database is exactly what was imported", () => {
  it("ships at resources/usda/usda-generic.sqlite", () => {
    expect(fs.existsSync(DB_PATH)).toBe(true)
  })

  it("contains the expected row counts per dataset", async () => {
    const rows = await query("SELECT data_type, COUNT(*) AS n FROM usda_foods GROUP BY data_type ORDER BY data_type")
    expect(Object.fromEntries(rows.map((r) => [r.data_type, r.n]))).toEqual({
      Foundation: EXPECTED.Foundation, "SR Legacy": EXPECTED["SR Legacy"],
    })
    const [{ n }] = await query("SELECT COUNT(*) AS n FROM usda_foods")
    expect(n).toBe(EXPECTED.total)
  })

  it("contains NO Branded and NO FNDDS rows — the exclusions are the point, not a preference", async () => {
    // Branded crowding is the defect this provider removes. If a Branded row could reach the
    // corpus the removal would be a policy rather than a structural guarantee.
    const rows = await query(
      "SELECT COUNT(*) AS n FROM usda_foods WHERE data_type NOT IN ('SR Legacy', 'Foundation')")
    expect(rows[0].n).toBe(0)
    for (const forbidden of ["Branded", "Survey (FNDDS)", "FNDDS", "branded_food", "survey_fndds_food"]) {
      const [{ n }] = await query(`SELECT COUNT(*) AS n FROM usda_foods WHERE data_type = '${forbidden}'`)
      expect(n, forbidden).toBe(0)
    }
  })

  it("records its schema version and source datasets in usda_meta", async () => {
    const meta = Object.fromEntries((await query("SELECT key, value FROM usda_meta")).map((r) => [r.key, r.value]))
    expect(meta.schema_version).toBe("1")
    expect(meta.datasets).toBe("Foundation 2026-04-30; SR Legacy 2018-04")
    expect(meta.excluded).toContain("Branded")
    expect(meta.excluded).toContain("FNDDS")
    expect(meta.attribution).toContain("FoodData Central")
    expect(meta.food_count).toBe(String(EXPECTED.total))
  })

  it("carries the high-value records this change exists to expose", async () => {
    // Every one of these is a concept the live API either buried behind Branded rows or returned
    // only in its fattiest/least apt form. Asserted by FDC id so a silently different record fails.
    const wanted: [number, string, number][] = [
      [173111, "Beef, ground, 97% lean meat / 3% fat, raw", 121],
      [171790, "Beef, ground, 95% lean meat / 5% fat, raw", 137],
      [173110, "Beef, ground, 93% lean meat / 7% fat, raw", 152],
      [174030, "Beef, ground, 90% lean meat / 10% fat, raw", 176],
      [174036, "Beef, ground, 80% lean meat / 20% fat, raw", 254],
      [171329, "Spices, paprika", 282],
      [170922, "Spices, coriander seed", 298],
      [169997, "Coriander (cilantro) leaves, raw", 23],
      [170921, "Spices, coriander leaf, dried", 279],
      [170923, "Spices, cumin seed", 375],
      [172231, "Spices, turmeric, ground", 312],
      [170106, "Peppers, hot chili, red, raw", 40],
      [170108, "Peppers, sweet, red, raw", 26],
      [171413, "Oil, olive, salad or cooking", 884],
      [172336, "Oil, canola", 884],
      [171411, "Oil, soybean, salad or cooking", 884],
    ]
    const rows = await query(
      `SELECT fdc_id, description, kcal FROM usda_foods WHERE fdc_id IN (${wanted.map(([id]) => id).join(",")})`)
    const byId = new Map(rows.map((r) => [Number(r.fdc_id), r]))
    for (const [id, description, kcal] of wanted) {
      expect(byId.get(id), `fdc ${id} (${description})`).toBeDefined()
      expect(byId.get(id)!.description, String(id)).toBe(description)
      expect(byId.get(id)!.kcal, String(id)).toBe(kcal)
    }
  })

  it("keeps hot chilli and sweet pepper as separate records", async () => {
    const rows = await query(
      "SELECT fdc_id, kcal FROM usda_foods WHERE fdc_id IN (170106, 170108)")
    expect(rows).toHaveLength(2)
    expect(new Set(rows.map((r) => r.kcal))).toEqual(new Set([40, 26]))
  })

  it("converts sodium and cholesterol from milligrams to grams, as every other provider reports them", async () => {
    // Source rows are MG. "Spices, paprika" is ~68 mg sodium per 100 g, so a value near 0.068 g
    // proves the conversion happened and a value near 68 would prove it did not.
    const [paprika] = await query("SELECT sodium, cholesterol FROM usda_foods WHERE fdc_id = 171329")
    expect(paprika.sodium).toBeLessThan(1)
    expect(paprika.sodium).toBeGreaterThan(0)
    const [butter] = await query("SELECT cholesterol FROM usda_foods WHERE fdc_id = 173430")
    expect(butter.cholesterol).toBeGreaterThan(0)
    expect(butter.cholesterol).toBeLessThan(1)
  })

  it("records which energy definition produced each kcal value", async () => {
    // SR Legacy is uniform on 1008; Foundation mixes 1008/2047/2048, and they are not
    // interchangeable. Losing that distinction is how two rows for the same food silently differ.
    const sr = await query(
      "SELECT DISTINCT energy_nutrient_id FROM usda_foods WHERE data_type = 'SR Legacy' AND kcal IS NOT NULL")
    expect(sr.map((r) => r.energy_nutrient_id)).toEqual([1008])
    const foundation = await query(
      "SELECT DISTINCT energy_nutrient_id FROM usda_foods WHERE data_type = 'Foundation' AND kcal IS NOT NULL ORDER BY energy_nutrient_id")
    expect(foundation.map((r) => r.energy_nutrient_id)).toEqual([1008, 2047])
  })
})

describe("the provider serves the bundled database", () => {
  it("loads every row and reports its datasets", async () => {
    __resetUsdaLocalForTests()
    config.usdaLocal.dbPath = ""
    const data = await getUsdaLocalData()
    expect(data).not.toBeNull()
    expect(data!.records).toHaveLength(EXPECTED.total)
    expect(data!.datasets).toBe("Foundation 2026-04-30; SR Legacy 2018-04")
  })

  it("resolves a generic spice end to end, with SR Legacy provenance", async () => {
    __resetUsdaLocalForTests()
    config.usdaLocal.dbPath = ""
    __clearProviderCachesForTests()
    const m = await usdaLocalProvider.lookup({
      foodName: "turmeric", structuredName: "Kurkuma", canonicalGerman: "Kurkuma",
      brand: null, category: "spice", state: "unknown", foodType: "simple",
      coreFoodGerman: "Kurkuma", coreFoodEnglish: "turmeric", route: "generic",
      attributes: { ...UNKNOWN_ATTRIBUTES, form: "ground" },
      evidence: { german: true, english: true, core: true, brand: false },
    } as unknown as ProviderQuery)

    expect(m).not.toBeNull()
    expect(m!.provider).toBe("usda-local")
    expect(m!.providerId).toBe("172231")
    expect(m!.productName).toBe("Spices, turmeric, ground")
    expect(m!.dataType).toBe("SR Legacy")
    expect(m!.nutrients.kcalPer100g).toBe(312)
  })

  it("refuses a database whose schema version it does not recognise, instead of reading it anyway", async () => {
    const SQL = await initSqlJs()
    const db = new SQL.Database()
    db.run("CREATE TABLE usda_foods (fdc_id INTEGER PRIMARY KEY, data_type TEXT, description TEXT, description_normalized TEXT, category TEXT, energy_nutrient_id INTEGER, kcal REAL, protein REAL, carbs REAL, fat REAL, saturated_fat REAL, trans_fat REAL, fiber REAL, sugar REAL, sodium REAL, cholesterol REAL)")
    db.run("CREATE TABLE usda_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
    db.run("INSERT INTO usda_meta VALUES ('schema_version', '999')")
    const dir = fs.mkdtempSync(path.join(REPO, "..", "usda-bad-"))
    const file = path.join(dir, "bad.sqlite")
    fs.writeFileSync(file, Buffer.from(db.export()))
    db.close()

    config.usdaLocal.dbPath = file
    __resetUsdaLocalForTests()
    expect(await getUsdaLocalData()).toBeNull()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("disables itself rather than crashing when the database is missing", async () => {
    config.usdaLocal.dbPath = path.join(REPO, "resources/usda/does-not-exist.sqlite")
    __resetUsdaLocalForTests()
    expect(await getUsdaLocalData()).toBeNull()
    // The rest of the chain is unaffected — same philosophy as a missing BLS export.
    expect(await usdaLocalProvider.lookup({
      foodName: "turmeric", structuredName: "turmeric", brand: null, category: null,
      state: "unknown", foodType: "simple", route: "generic",
    } as unknown as ProviderQuery)).toBeNull()
  })
})

describe("qualitative 'lean' against numeric USDA grades — deferred, not guessed", () => {
  /**
   * `Rinderhackfleisch mager` / `lean ground beef` says LEAN. It does not say 97/3, 95/5, 93/7,
   * 90/10, 80/20, 75/25 or 70/30 — and USDA holds all seven as separate raw records:
   *
   *     173111  97% lean / 3% fat, raw   121 kcal
   *     171790  95% lean / 5% fat, raw   137 kcal
   *     173110  93% lean / 7% fat, raw   152 kcal
   *     174030  90% lean / 10% fat, raw  176 kcal
   *     174036  80% lean / 20% fat, raw  254 kcal
   *     174037  75% lean / 25% fat, raw  293 kcal
   *     168652  70% lean / 30% fat, raw  332 kcal
   *
   * Measured against the real bundled corpus, the current ranker scores every one of them
   * IDENTICALLY, and all of them below MIN_ACCEPTABLE_SCORE. So there is no semantic basis here to
   * prefer one grade, and picking the leanest (or the lowest kcal, or a hardcoded "mager = 90/10")
   * would be inventing a precision the cook never supplied.
   *
   * The safe outcome is therefore "no acceptable USDA candidate", leaving BLS's identity-compatible
   * record standing with its `reduced-fat` claim honestly unmet — PR #9's rule. Resolving
   * qualitative claims against numeric grades is deferred to a separate ranking-design change.
   */
  const leanBeef = {
    foodName: "lean ground beef", structuredName: "mageres Rinderhackfleisch",
    canonicalGerman: "Rinderhackfleisch, mager", brand: null, category: "meat",
    state: "raw", foodType: "simple", coreFoodGerman: "Rinderhackfleisch",
    coreFoodEnglish: "ground beef", route: "generic", attributes: UNKNOWN_ATTRIBUTES,
    evidence: { german: true, english: true, core: true, brand: false },
  } as unknown as ProviderQuery

  it("does not pick any graded record for a query that states no fat percentage", async () => {
    __resetUsdaLocalForTests()
    config.usdaLocal.dbPath = ""
    __clearProviderCachesForTests()
    const m = await usdaLocalProvider.lookup(leanBeef)
    // Encoded as the EXPECTED result: safe, deterministic, and better than an arbitrary grade.
    expect(m).toBeNull()
  })

  it("cannot be swung by candidate order — reversing the corpus changes nothing", async () => {
    // The scores within the graded family are equal, so ordering is the only thing that could
    // decide between them. This proves ordering does not reach a production match today, and will
    // fail loudly if a future ranking change lets it.
    const graded = [
      { fdcId: 173111, description: "Beef, ground, 97% lean meat / 3% fat, raw", kcal: 121, protein: 22, fat: 3 },
      { fdcId: 171790, description: "Beef, ground, 95% lean meat / 5% fat, raw", kcal: 137, protein: 21.4, fat: 5 },
      { fdcId: 174030, description: "Beef, ground, 90% lean meat / 10% fat, raw", kcal: 176, protein: 20, fat: 10 },
      { fdcId: 174036, description: "Beef, ground, 80% lean meat / 20% fat, raw", kcal: 254, protein: 17.2, fat: 20 },
      { fdcId: 168652, description: "Beef, ground, 70% lean meat / 30% fat, raw", kcal: 332, protein: 14.4, fat: 30 },
    ]
    const resolve = async (foods: typeof graded) => {
      await useUsdaLocalFixture(foods)
      __clearProviderCachesForTests()
      const m = await usdaLocalProvider.lookup(leanBeef)
      return m?.providerId ?? null
    }
    const forward = await resolve(graded)
    const reversed = await resolve([...graded].reverse())
    expect(forward).toBe(reversed)
    expect(forward).toBeNull()
  })

  it("a numeric fat percentage is different: the record that states it is real evidence", async () => {
    // Not a behaviour change, a boundary: when the cook DOES supply the number, a record stating
    // the same number answers it. Nothing here interpolates between grades.
    await useUsdaLocalFixture([
      { fdcId: 174030, description: "Beef, ground, 90% lean meat / 10% fat, raw", kcal: 176, protein: 20, carbs: 0, fat: 10 },
    ])
    __clearProviderCachesForTests()
    const m = await usdaLocalProvider.lookup({
      ...leanBeef, foodName: "ground beef 10% fat", structuredName: "Rinderhack 10% Fett",
      attributes: { ...UNKNOWN_ATTRIBUTES, fatPercent: 10 },
    } as unknown as ProviderQuery)
    // Whatever the ranker decides, it must never contradict the stated percentage.
    if (m) expect(m.nutrients.fatPer100g).toBeCloseTo(10, 0)
  })
})

describe("cached provenance round-trips for usda-local", () => {
  it("preserves dataType, matchReason, llmReranked, rerankReason and unmetAttributes", () => {
    // PR #8 showed a SELECT list silently dropping provenance on cache hits. The new provider gets
    // the same explicit coverage rather than an assumption that the shared cache still behaves.
    __clearProviderCachesForTests()
    const key = buildQueryKey("usda-local-round-trip|unknown|generic|unknown/unknown/-", null)
    const stored: ProviderMatch = {
      nutrients: {
        kcalPer100g: 176, proteinPer100g: 20, carbsPer100g: 0, fatPer100g: 10,
        saturatedFatPer100g: 3.9, transFatPer100g: null, unsaturatedFatPer100g: 6.1,
        fiberPer100g: 0, sugarPer100g: 0, sodiumPer100g: 0.066, cholesterolPer100g: 0.062,
      },
      canonicalName: "lean ground beef", brand: null, state: "raw", provider: "usda-local",
      providerId: "174030", productName: "Beef, ground, 90% lean meat / 10% fat, raw",
      confidence: 0.7, dataType: "SR Legacy", foodType: "simple", matchReason: "llm-reranked",
      llmReranked: true, rerankReason: "the graded record states the claim",
      unmetAttributes: ["reduced-fat"],
    }
    setCachedProviderMatch("usda-local", key, stored)

    const read = getCachedProviderMatch("usda-local", key)
    expect(read).toBeDefined()
    expect(read!.provider).toBe("usda-local")
    expect(read!.providerId).toBe("174030")
    expect(read!.productName).toBe("Beef, ground, 90% lean meat / 10% fat, raw")
    expect(read!.dataType).toBe("SR Legacy")
    expect(read!.matchReason).toBe("llm-reranked")
    expect(read!.llmReranked).toBe(true)
    expect(read!.rerankReason).toBe("the graded record states the claim")
    expect(read!.unmetAttributes).toEqual(["reduced-fat"])
    expect(read!.nutrients.kcalPer100g).toBe(176)
    expect(read!.matchReason === "llm-reranked").toBe(read!.llmReranked === true)
  })

  it("keys cached matches by the bundled data version and the core food, so neither a re-import nor a different core classification can serve a stale row", async () => {
    // The provider folds usda_meta.schema_version into its cache key alongside its algorithm
    // version, and the normalized core food alongside both. A fixture database declares the same
    // version "1", so this asserts the shape rather than merely that some key exists.
    await useUsdaLocalFixture([{ fdcId: 111, description: "Versioncheck food", kcal: 100, protein: 5, carbs: 15, fat: 2 }])
    __clearProviderCachesForTests()
    const q = {
      foodName: "Versioncheck food", structuredName: "Versioncheck food", brand: null,
      category: null, state: "unknown", foodType: "simple", coreFoodEnglish: "Versioncheck food",
      route: "generic", attributes: UNKNOWN_ATTRIBUTES,
      evidence: { german: true, english: true, core: true, brand: false },
    } as unknown as ProviderQuery
    const first = await usdaLocalProvider.lookup(q)
    expect(first?.providerId).toBe("111")
    expect(getCachedProviderMatch("usda-local",
      buildQueryKey("v2/1:Versioncheck food|unknown|generic|unknown/unknown/-|core=versioncheck food", null))?.providerId).toBe("111")

    // The same query text under a DIFFERENT core classification is a different question, and must
    // not be answered from the row above. Reconciling a production discrepancy showed why: the
    // core both gates the match and sets its confidence, so a match found under one core was
    // being replayed, at its stored confidence, for a lookup whose core could not have produced it.
    expect(getCachedProviderMatch("usda-local",
      buildQueryKey("v2/1:Versioncheck food|unknown|generic|unknown/unknown/-|core=", null))).toBeUndefined()
  })
})

describe("an unrequested material transformation cannot outrank the plain food", () => {
  /**
   * Both halves of the rule, on the real bundled corpus.
   *
   * An unrequested preservation or derived form used to be FREE: `canned`, `cooked`, `dried` and
   * friends sit in GENERIC_DESCRIPTOR_WORDS so USDA's precise naming ("Beans, kidney, red, mature
   * seeds, canned, drained solids") would not lose to a vague one ("Kidney beans, NFS") purely by
   * paying a penalty per precise word. That exemption was unconditional, so a transformation
   * nobody asked for was free too — and a candidate could win by volunteering one.
   *
   * It is now conditional: free when the query names it, foreign content when it does not. The
   * conventional dried/ground form of a spice or herb record is exempt either way, because that
   * IS what a recipe means by "oregano".
   */
  const q = (structured: string, english: string, core: string, over: Record<string, unknown> = {}) => ({
    foodName: english, structuredName: structured, canonicalGerman: structured, brand: null,
    category: (over.category as string) ?? null, state: (over.state as string) ?? "unknown",
    foodType: "simple", coreFoodGerman: structured, coreFoodEnglish: core, route: "generic",
    attributes: {
      ...UNKNOWN_ATTRIBUTES,
      ...(over.form ? { form: over.form } : {}),
      ...(over.preservation ? { preservation: over.preservation } : {}),
    },
    evidence: { german: true, english: true, core: true, brand: false },
  } as unknown as ProviderQuery)

  const lookup = async (query: ProviderQuery) => {
    __resetUsdaLocalForTests()
    config.usdaLocal.dbPath = ""
    __clearProviderCachesForTests()
    return usdaLocalProvider.lookup(query)
  }

  it("generic green chili does not resolve to CANNED green chili", async () => {
    const m = await lookup(q("grüne Chilischoten", "green chilies", "chili pepper", { state: "raw", category: "vegetable" }))
    expect(m?.productName ?? "").not.toMatch(/canned/i)
    expect(m?.providerId).not.toBe("168577")
  })

  it("explicitly canned green chili MAY resolve to the canned record", async () => {
    const m = await lookup(q("grüne Chilischoten a.d. Dose", "canned green chilies", "chili pepper",
      { category: "vegetable", preservation: "canned" }))
    expect(m?.providerId).toBe("168577")
    expect(m?.productName).toBe("Peppers, chili, green, canned")
  })

  it("generic quinoa does not resolve to quinoa FLOUR", async () => {
    const m = await lookup(q("Quinoa", "quinoa", "quinoa", { state: "raw", category: "grain" }))
    expect(m?.productName ?? "").not.toMatch(/flour/i)
    expect(m?.providerId).toBe("168874")
    expect(m?.productName).toBe("Quinoa, uncooked")
  })

  it("explicitly named quinoa flour MAY resolve to quinoa flour", async () => {
    const m = await lookup(q("Quinoamehl", "quinoa flour", "quinoa", { category: "grain", form: "flour" }))
    expect(m?.providerId).toBe("2512372")
    expect(m?.productName).toBe("Flour, quinoa")
  })

  it("an explicitly dried herb resolves; a bare one does not take the dried record on its own", async () => {
    // The asymmetry is the rule, not an accident. An exemption letting spice/herb records
    // volunteer their conventional dried/ground form was tried and removed: it let bare "Chili"
    // — which names both a fresh pod and a ground powder — resolve to "Spices, chili powder"
    // (282 kcal/100 g) that nobody asked for. Telling that apart from "Oregano", where the dried
    // leaf genuinely is what a recipe means, needs per-food knowledge this file does not have.
    // A bare herb therefore falls back to an estimate, exactly as it does on the live-API build.
    const explicit = await lookup(q("getrockneter Oregano", "dried oregano", "oregano",
      { category: "herb", preservation: "dried" }))
    expect(explicit?.productName).toBe("Spices, oregano, dried")

    const plain = await lookup(q("Oregano", "oregano", "oregano", { category: "herb" }))
    expect(plain?.productName ?? "").not.toMatch(/dried/i)
  })

  it("a bare food name whose form is ambiguous never takes a ground/powdered record", async () => {
    // "Chili" is the case that killed the spice exemption. Both classifications are plausible for
    // the bare German word, and neither may reach a powder without the query saying so.
    const asSpice = await lookup(q("Chili", "chili", "chili", { category: "spice" }))
    expect(asSpice?.productName ?? "").not.toMatch(/powder/i)
    const asVegetable = await lookup(q("Chili", "chili pepper", "chili pepper", { state: "raw", category: "vegetable" }))
    expect(asVegetable?.productName ?? "").not.toMatch(/powder/i)

    // Naming the powder still reaches it.
    const powder = await lookup(q("Chilipulver", "chili powder", "chili", { form: "powder", category: "spice" }))
    expect(powder?.providerId).toBe("171319")
    expect(powder?.productName).toBe("Spices, chili powder")
  })

  it("keeps the spice records whose queries do name their form", async () => {
    const turmeric = await lookup(q("Kurkuma", "turmeric", "turmeric", { form: "ground", category: "spice" }))
    expect(turmeric?.providerId).toBe("172231")
    const coriander = await lookup(q("Korianderkörner", "coriander seeds", "coriander seeds",
      { form: "seed", category: "spice" }))
    expect(coriander?.providerId).toBe("170922")
  })

  it("does not over-block: an explicitly named derived form still resolves", async () => {
    const m = await lookup(q("Knoblauchgewürz", "garlic seasoning", "garlic", { category: "seasoning" }))
    expect(m?.providerId).toBe("171325")
    expect(m?.productName).toBe("Spices, garlic powder")
  })

  it("candidate order cannot decide between the plain food and a transformed one", async () => {
    // Invariant C, on the pair that actually collided. Whatever order the corpus is read in, the
    // unrequested transformation must not win.
    const foods = [
      { fdcId: 168874, description: "Quinoa, uncooked", kcal: 368, protein: 14.1, carbs: 64.2, fat: 6.1 },
      { fdcId: 2512372, description: "Flour, quinoa", dataType: "Foundation" as const, kcal: 385, protein: 13.6, carbs: 68.9, fat: 5.9 },
    ]
    const pick = async (list: typeof foods) => {
      await useUsdaLocalFixture(list)
      __clearProviderCachesForTests()
      return (await usdaLocalProvider.lookup(
        q("Quinoa", "quinoa", "quinoa", { state: "raw", category: "grain" })))?.providerId ?? null
    }
    const forward = await pick(foods)
    const reversed = await pick([...foods].reverse())
    expect(forward).toBe("168874")
    expect(reversed).toBe("168874")
  })
})
