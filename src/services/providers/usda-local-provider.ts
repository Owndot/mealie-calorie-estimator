import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import initSqlJs from "sql.js"
import { config } from "../../config.js"
import { logger } from "../../utils/logger.js"
import { getCachedProviderMatch, setCachedProviderMatch, isProviderMiss, markProviderMiss, buildQueryKey } from "../../utils/cache.js"
import type { NutrientSet, ProviderMatch, FoodRoute, FoodType, FoodState } from "../../types.js"
import type { NutrientProvider, ProviderQuery } from "./types.js"
import {
  rankCandidates, MIN_ACCEPTABLE_SCORE, inferStateFromName, cachedMatchConflict, matchingContextKey,
  tokenize, englishTokenSpellings, answersOnlyPartOfCore, GENERIC_DESCRIPTOR_WORDS,
  type RankableCandidate, type RankedCandidate,
} from "./ranking.js"
import { FULL_EVIDENCE } from "../identity-evidence.js"
import { attributesKey, inferAttributesFromName, unmetModifierFamilies } from "./food-semantics.js"
import { rerankCandidates, rerankTrigger, identityKey, RERANK_MIN_CANDIDATE_SCORE, type TriggerCandidate } from "./candidate-rerank.js"
import { UNKNOWN_ATTRIBUTES, type FoodAttributes } from "../../types.js"

/**
 * USDA FoodData Central GENERIC foods, served from a bundled SQLite extract instead of the live
 * search API.
 *
 * The semantics are deliberately the ones the API provider already had — same ranking, same gates,
 * same reranker, same confidence ladder. ONLY RETRIEVAL CHANGED, because retrieval was the defect:
 *
 *   A live `pageSize=25` search for "ground beef" returned 25 Branded rows out of 25, leaving the
 *   generic route nothing at all after its Branded filter. "lean ground beef" returned 20 Branded
 *   and five generic rows, every one of them 70/30, 75/25 or 80/20 — the fattiest grades — while
 *   SR Legacy holds 97/3, 95/5, 93/7 and 90/10 raw the whole time. The database was never missing
 *   lean mince; the result window was.
 *
 * Here there is no window. Every generic record is a candidate on every lookup, and Branded
 * crowding is not mitigated but structurally impossible: no Branded row is imported, so the
 * dataset cannot contain one (scripts/import_usda.py asserts this, as do the import tests).
 *
 * Bundled datasets: Foundation Foods 2026-04-30 and SR Legacy 2018-04. FNDDS is excluded
 * deliberately — measured, it lifted two benchmark concepts while adding 5,432 rows, 2,710 of them
 * prepared or composite dishes, and inflating candidate sets by ~65%.
 */

const PROVIDER_NAME = "usda-local"

/**
 * Bumped whenever retrieval, ranking or import normalization changes — provider_match_cache has no
 * other versioning, so without this a fix would be masked by cached matches for up to the match
 * TTL. The bundled database's own schema_version is folded in alongside (see lookup()), so
 * re-importing a new USDA release also invalidates this provider's cached matches and cannot leave
 * a stale row pointing at an fdc_id that moved.
 */
const USDA_LOCAL_MATCH_ALGORITHM_VERSION = "v2"

/** The importer's output contract. A database written by a different shape must not be read. */
const SUPPORTED_SCHEMA_VERSION = "1"

/**
 * Dataset-tier ranking signal — not a hard filter; the identity/state/category gates still apply.
 * Foundation is the newer analytical programme and SR Legacy the broader curated one. Foundation
 * is scored above SR only as a tie-break, never enough to beat a better-matching SR record:
 * Foundation is 469 rows, 91 of which carry no energy at all (every Foundation oil among them),
 * and it mixes energy bases where SR is uniform. Branded/FNDDS values are listed for completeness
 * only — neither dataset is imported, so neither can ever be scored.
 */
function dataTypeScore(dataType: string | null | undefined): number {
  if (dataType === "Foundation") return 20
  if (dataType === "SR Legacy") return 15
  return 0
}

/**
 * Categories from USDA's own `food_category` metadata that signal a multi-ingredient prepared
 * dish. Carried over verbatim from the API provider — the category strings are the same field,
 * and this list was validated against live results.
 */
const USDA_COMPOSITE_DISH_CATEGORIES = [
  "pudding", "cakes and pies", "ice cream and frozen dairy desserts", "baby food",
  "fast foods", "soups, sauces, and gravies", "restaurant foods", "meals, entrees, and side dishes",
  "sandwiches", "mixed dishes", "cookies and brownies", "candy",
]

function usdaFoodType(foodCategory: string | null | undefined): FoodType {
  if (!foodCategory) return "unknown"
  const normalized = foodCategory.toLowerCase()
  return USDA_COMPOSITE_DISH_CATEGORIES.some((c) => normalized.includes(c)) ? "composite_dish" : "simple"
}

interface UsdaRecord {
  fdcId: number
  dataType: string
  description: string
  descriptionNormalized: string
  category: string | null
  /** Which FoodData Central nutrient id supplied kcal — 1008, 2047 or 2048. See usda_meta. */
  energyNutrientId: number | null
  nutrients: NutrientSet
  state: FoodState
  foodType: FoodType
  attributes: FoodAttributes
  /** Precomputed once at load; recomputing per query over 8,262 records is measurably slower. */
  tokens: string[]
  tokenSet: Set<string>
}

interface UsdaData {
  records: UsdaRecord[]
  version: string
  datasets: string
}

function defaultDbPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url))
  return path.join(here, "../../../resources/usda/usda-generic.sqlite")
}

let loadPromise: Promise<UsdaData | null> | null = null

async function loadUsdaData(): Promise<UsdaData | null> {
  const dbPath = config.usdaLocal.dbPath || defaultDbPath()

  // Same failure philosophy as the BLS provider: a missing bundled resource disables THIS
  // provider loudly and leaves the rest of the chain working, rather than taking the service
  // down. There is deliberately no fallback to the live API — that path is gone, and silently
  // reaching for the network is exactly the non-determinism this replaces.
  if (!fs.existsSync(dbPath)) {
    logger.warn({ dbPath }, "USDA local database not found — USDA provider disabled for this run")
    return null
  }

  const SQL = await initSqlJs()
  const db = new SQL.Database(fs.readFileSync(dbPath))

  const meta = new Map<string, string>()
  const metaStmt = db.prepare("SELECT key, value FROM usda_meta")
  while (metaStmt.step()) {
    const row = metaStmt.getAsObject() as { key: string; value: string }
    meta.set(row.key, row.value)
  }
  metaStmt.free()

  const schemaVersion = meta.get("schema_version")
  if (schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    logger.error(
      { dbPath, schemaVersion, supported: SUPPORTED_SCHEMA_VERSION },
      "USDA local database has an unsupported schema version — USDA provider disabled. Re-run scripts/import_usda.py",
    )
    db.close()
    return null
  }

  const records: UsdaRecord[] = []
  const stmt = db.prepare(`SELECT fdc_id, data_type, description, description_normalized, category,
    energy_nutrient_id, kcal, protein, carbs, fat, saturated_fat, trans_fat, fiber, sugar, sodium,
    cholesterol FROM usda_foods`)
  while (stmt.step()) {
    const r = stmt.getAsObject() as Record<string, string | number | null>
    const num = (k: string): number | null => (typeof r[k] === "number" ? (r[k] as number) : null)
    const description = String(r.description)
    const tokens = tokenize(description)
    records.push({
      fdcId: Number(r.fdc_id),
      dataType: String(r.data_type),
      description,
      descriptionNormalized: String(r.description_normalized),
      category: r.category === null ? null : String(r.category),
      energyNutrientId: num("energy_nutrient_id"),
      nutrients: {
        kcalPer100g: num("kcal"),
        proteinPer100g: num("protein"),
        carbsPer100g: num("carbs"),
        fatPer100g: num("fat"),
        saturatedFatPer100g: num("saturated_fat"),
        transFatPer100g: num("trans_fat"),
        // Derived exactly as the API provider derived it, so a record's macro shape does not
        // change with the retrieval path.
        unsaturatedFatPer100g: num("fat") === null
          ? null
          : Math.max(0, Number((num("fat")! - (num("saturated_fat") ?? 0) - (num("trans_fat") ?? 0)).toFixed(4))),
        fiberPer100g: num("fiber"),
        sugarPer100g: num("sugar"),
        // Already converted mg -> g by the importer, matching every other provider's NutrientSet.
        sodiumPer100g: num("sodium"),
        cholesterolPer100g: num("cholesterol"),
      },
      state: inferStateFromName(description),
      foodType: usdaFoodType(r.category === null ? null : String(r.category)),
      attributes: inferAttributesFromName(description),
      tokens,
      tokenSet: new Set(tokens),
    })
  }
  stmt.free()
  db.close()

  logger.info(
    { count: records.length, datasets: meta.get("datasets"), dbPath },
    "Loaded USDA FoodData Central generic database",
  )
  return { records, version: meta.get("schema_version") ?? "?", datasets: meta.get("datasets") ?? "?" }
}

export function getUsdaLocalData(): Promise<UsdaData | null> {
  loadPromise ??= loadUsdaData().catch((err) => {
    logger.error({ err }, "Failed to load USDA local database — USDA provider disabled for this run")
    return null
  })
  return loadPromise
}

/** Test seam: forces the next lookup to re-read the database from disk. */
export function __resetUsdaLocalForTests(): void {
  loadPromise = null
}

/** English identity of a candidate name: the words that actually name a food. */
function identityTokensOf(name: string): string[] {
  const kept = tokenize(name).filter((t) => t.length >= 3 && !/^\d/.test(t) && !GENERIC_DESCRIPTOR_WORDS.has(t))
  return kept.length > 0 ? kept : tokenize(name)
}

interface RankableUsdaRecord extends RankableCandidate {
  record: UsdaRecord
}
type RankedUsda = RankedCandidate<RankableUsdaRecord> & { rerankConfidence?: number; rerankReason?: string | null }

/**
 * Narrows 8,262 records to those that could conceivably survive the gates, by requiring at least
 * one shared non-generic token with the query.
 *
 * This is RETRIEVAL, not a semantic gate, and that distinction matters: a record sharing no
 * meaningful word with the query can never pass coreIdentityConflict, so nothing reachable is
 * hidden — unlike the API's relevance window, which hid records that would have won. With no
 * usable token the whole pool is returned rather than nothing, so the gates decide, never this.
 */
function retrieve(records: UsdaRecord[], queryText: string, core: string | null | undefined): UsdaRecord[] {
  const asked = [...tokenize(queryText), ...tokenize(core ?? "")]
    .filter((t) => t.length > 2 && !GENERIC_DESCRIPTOR_WORDS.has(t))
  if (asked.length === 0) return records
  // Retrieval must be AT LEAST as tolerant as the identity gate it feeds, or it decides identity
  // by spelling. Exact tokenSet membership was not: USDA files this family as "Beans, black,
  // mature seeds, raw" while production's classifier said "black bean" / core "bean", so the
  // plural token the record actually carries was never asked for. Expanding each asked token to
  // the spellings englishTokenMatches() accepts keeps the O(1) index lookup and removes the
  // singular/plural fork entirely — see englishTokenSpellings().
  const wanted = new Set(asked.flatMap(englishTokenSpellings))
  const hits = records.filter((r) => {
    for (const t of wanted) if (r.tokenSet.has(t)) return true
    return false
  })
  return hits.length > 0 ? hits : []
}

export class UsdaLocalProvider implements NutrientProvider {
  readonly name = PROVIDER_NAME

  async lookup(query: ProviderQuery): Promise<ProviderMatch | null> {
    const data = await getUsdaLocalData()
    if (!data) return null

    const route: FoodRoute = query.route ?? "generic"
    const attrs = query.attributes ?? UNKNOWN_ATTRIBUTES

    const evidence = query.evidence ?? FULL_EVIDENCE
    // USDA indexes ENGLISH descriptions. Unchanged from the API provider: with a validated English
    // identity this is the normal generic path; without one the raw structured name becomes the
    // core gate, which fails closed for a German-only ingredient.
    const strictCore = evidence.english ? query.coreFoodEnglish : (query.structuredName ?? query.foodName)

    // The bundled data's schema version rides in the cache key alongside the algorithm version, so
    // a re-import invalidates this provider's cached matches without touching anyone else's.
    //
    // The core food is part of the key HERE, and deliberately not in the network providers (see
    // cachedMatchConflict()'s note on cache fragmentation). The trade-off is different for a local
    // database: a miss costs an in-memory rank over 8,262 rows, not an API call, so there is no
    // rate-limit pressure to trade correctness against. And correctness needed it — the core both
    // gates the match AND sets its confidence (a null core is capped at 0.55, a present one earns
    // 0.7/0.8), while cachedMatchConflict is deliberately permissive when the core is absent. A
    // match found under core "cucumber water" was therefore reusable, at its stored 0.7, for a
    // later lookup that had no core at all. Keying on the core makes those separate questions.
    const queryKey = buildQueryKey(
      `${USDA_LOCAL_MATCH_ALGORITHM_VERSION}/${data.version}:${query.foodName}|${query.state}|${route}` +
      `|${attributesKey(attrs)}|core=${tokenize(strictCore ?? "").join(" ")}`,
      query.brand,
    )

    const ctx = {
      foodName: query.foodName, category: query.category, foodType: query.foodType,
      coreFood: strictCore, coreMatchMode: "token" as const, evidence, attributes: attrs,
    }
    const missKey = `${queryKey}|ctx=${matchingContextKey(ctx)}`

    const cached = getCachedProviderMatch(this.name, queryKey)
    if (cached) {
      const conflict = cachedMatchConflict(cached, ctx)
      if (!conflict) return cached
      logger.info({ foodName: query.foodName, reason: conflict }, "USDA local: cached match incompatible with this query's context, re-ranking")
    }
    if (isProviderMiss(this.name, missKey)) return null

    const candidates = retrieve(data.records, query.foodName, strictCore)
    if (candidates.length === 0) {
      markProviderMiss(this.name, missKey)
      return null
    }

    const rankable: RankableUsdaRecord[] = candidates.map((record) => ({
      record,
      name: record.description,
      brand: null,
      hasCompleteNutrients: record.nutrients.kcalPer100g != null,
      dataType: record.dataType,
      state: record.state,
      foodType: record.foodType,
    }))

    const ranked = rankCandidates(query.foodName, query.brand, rankable, {
      queryState: query.state,
      queryCategory: query.category,
      queryFoodType: query.foodType,
      queryCoreFood: strictCore,
      coreMatchMode: "token" as const,
      queryAttributes: attrs,
      candidateFat: (c) => (c as RankableUsdaRecord).record.nutrients.fatPer100g,
      // No Branded rows exist to reject, but the flag stays truthful about the route's intent.
      rejectBrandedWithoutBrandEvidence: route === "generic" && !query.brand,
      dataTypeScore,
    })

    // Same contract as BLS: everything that survived the HARD GATES, reported before any score
    // threshold is applied. MIN_ACCEPTABLE_SCORE below decides what this provider will USE; it
    // must not decide what a judge is allowed to SEE.
    if (query.candidateSink) {
      const survivors = ranked.filter((r) => !r.mismatchReason && r.candidate.record.nutrients.kcalPer100g !== null)
      if (survivors.length > 0) {
        query.candidateSink(survivors.map((r) => {
          const rec = r.candidate.record
          return {
            id: `usda-local:${rec.fdcId}`,
            provider: "usda-local",
            providerId: String(rec.fdcId),
            name: rec.description,
            dataType: rec.dataType,
            brand: null,
            category: rec.category,
            state: rec.state,
            form: rec.attributes.form,
            preservation: rec.attributes.preservation,
            nutrients: rec.nutrients,
            score: r.score,
          }
        }))
      }
    }

    const reranked = await this.maybeRerank(query, ranked, attrs, strictCore)
    const top: RankedUsda | undefined = reranked ?? ranked[0]

    if (!top) {
      markProviderMiss(this.name, missKey)
      return null
    }
    if (top.mismatchReason) {
      logger.info({ foodName: query.foodName, reason: top.mismatchReason }, "USDA local: rejected obvious mismatch")
      markProviderMiss(this.name, missKey)
      return null
    }
    if (top.score < MIN_ACCEPTABLE_SCORE) {
      logger.debug({ foodName: query.foodName, topScore: top.score, candidates: candidates.length }, "USDA local: no acceptable candidate")
      markProviderMiss(this.name, missKey)
      return null
    }

    const record = top.candidate.record
    if (record.nutrients.kcalPer100g === null) {
      markProviderMiss(this.name, missKey)
      return null
    }

    const unmet = unmetModifierFamilies(query.structuredName ?? query.foodName, record.description)

    const match: ProviderMatch = {
      nutrients: record.nutrients,
      canonicalName: query.foodName,
      brand: query.brand,
      state: query.state,
      provider: this.name,
      providerId: String(record.fdcId),
      productName: record.description,
      // Identical ladder to the API provider — the records and the ranking are the same, so the
      // confidence they earn is the same.
      confidence: top.rerankConfidence !== undefined
        ? Math.min(0.8, top.rerankConfidence)
        : !strictCore?.trim()
          ? Math.min(0.55, top.score / 100)
          : top.score >= MIN_ACCEPTABLE_SCORE + 25 ? 0.8 : 0.7,
      dataType: record.dataType,
      foodType: record.foodType,
      matchReason: top.rerankConfidence !== undefined
        ? "llm-reranked"
        : query.foodName.trim().toLowerCase() === record.description.trim().toLowerCase() ? "exact-name" : "fuzzy",
      ...(top.rerankConfidence !== undefined ? { llmReranked: true as const, rerankReason: top.rerankReason ?? null } : {}),
      ...(unmet.length > 0 ? { unmetAttributes: unmet } : {}),
    }

    setCachedProviderMatch(this.name, queryKey, match)
    return match
  }

  /**
   * The shared semantic judge, on the same terms as BLS and the former API provider: it chooses
   * BETWEEN records retrieval already found and the gates already approved, and NONE leaves the
   * deterministic outcome exactly as it was. The model never supplies a nutrient value — the
   * numbers always come from the selected USDA record.
   */
  private async maybeRerank(
    query: ProviderQuery,
    ranked: RankedCandidate<RankableUsdaRecord>[],
    attrs: FoodAttributes,
    core: string | null | undefined,
  ): Promise<RankedUsda | null> {
    if (!config.llm.enabled || !config.llm.apiKey || !config.llm.rerankEnabled) return null

    const asTrigger = (r: RankedCandidate<RankableUsdaRecord>): TriggerCandidate => ({
      score: r.score,
      record: {
        blsCode: String(r.candidate.record.fdcId),
        nutrients: { kcalPer100g: r.candidate.record.nutrients.kcalPer100g },
        attributes: r.candidate.record.attributes,
        inferredState: r.candidate.record.state,
        identityTokens: identityTokensOf(r.candidate.record.description),
      },
    })

    const eligible = ranked.filter((r) => !r.mismatchReason && r.score >= RERANK_MIN_CANDIDATE_SCORE)
    if (eligible.length === 0) return null
    const pool = new Map(eligible.map((r) => [String(r.candidate.record.fdcId), asTrigger(r)]))

    const accepted = ranked[0] && !ranked[0].mismatchReason && ranked[0].score >= MIN_ACCEPTABLE_SCORE ? ranked[0] : null
    const reason = rerankTrigger(accepted ? asTrigger(accepted) : null, pool, attrs, query.state)
      ?? (accepted && answersOnlyPartOfCore(core, accepted.candidate.record.description) ? "partial-core" : null)
    if (!reason) return null

    const offered = eligible.slice(0, config.llm.rerankMaxCandidates)
    const decision = await rerankCandidates(
      {
        provider: this.name,
        structuredName: query.structuredName ?? query.foodName,
        canonicalGerman: query.canonicalGerman ?? null,
        canonicalEnglish: query.foodName,
        coreFood: core ?? null,
        state: query.state,
        attributes: attrs,
      },
      offered.map((r) => ({
        providerId: String(r.candidate.record.fdcId),
        productName: r.candidate.record.description,
        kcalPer100g: r.candidate.record.nutrients.kcalPer100g,
        form: r.candidate.record.attributes.form,
        preservation: r.candidate.record.attributes.preservation,
        score: r.score,
        unmet: unmetModifierFamilies(query.foodName, r.candidate.record.description),
      })),
    )

    if (!decision) return null
    if (decision.providerId === null) {
      logger.info({ foodName: query.foodName, trigger: reason, reason: decision.reason }, "USDA local: rerank declined every candidate")
      return { candidate: offered[0].candidate, score: -1000, mismatchReason: `rerank declined: ${decision.reason}` }
    }

    const selected = offered.find((r) => String(r.candidate.record.fdcId) === decision.providerId)
    if (!selected) return null
    if (accepted && identityKey(asTrigger(selected).record.identityTokens) === identityKey(asTrigger(accepted).record.identityTokens)) return null

    return { ...selected, rerankConfidence: decision.confidence, rerankReason: decision.reason }
  }
}

export const usdaLocalProvider = new UsdaLocalProvider()
