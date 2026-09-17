import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import initSqlJs from "sql.js"
import { config } from "../../config.js"
import { rerankCandidates, rerankTrigger, attributeFit, identityKey, RERANK_MIN_CANDIDATE_SCORE, type TriggerCandidate } from "./candidate-rerank.js"
import { logger } from "../../utils/logger.js"
import { getCachedProviderMatch, setCachedProviderMatch, isProviderMiss, markProviderMiss, buildQueryKey, normalizeKey } from "../../utils/cache.js"
import type { NutrientSet, ProviderMatch, FoodState, FoodType, FoodAttributes } from "../../types.js"
import type { NutrientProvider, ProviderQuery } from "./types.js"
import { findMismatch, categoryConflict, foodTypeConflict, coreIdentityConflict, coreIdentityScoreAdjustment, cachedMatchConflict, matchingContextKey, GENERIC_DESCRIPTOR_WORDS, specificityConflict, sharesFullQueryIdentity, unmetModifierPenalty, UNMET_MODIFIER_WEIGHT } from "./ranking.js"
import { GERMAN_DESCRIPTOR_WORDS, germanTokenMatches, germanStem, standalonePlantPart, unmetModifierFamilies, type PlantPart } from "./food-semantics.js"
import { normalizeGermanText } from "../../utils/text-normalize.js"
import { FULL_EVIDENCE, usesDegradedBlsPolicy } from "../identity-evidence.js"
import {
  compoundMatchesTokens, formConflict, preservationConflict, fatConflict, freshVsProcessedFormConflict, fatApproximate,
  inferAttributesFromName, attributesKey, statedPreparation,
} from "./food-semantics.js"
import { UNKNOWN_ATTRIBUTES } from "../../types.js"
import { sanityCheckNutrients } from "../sanity-check.js"

/** See the queryKey comment in BlsProvider.lookup() — bump on any nameScore matching-behavior change. */
const BLS_MATCH_ALGORITHM_VERSION = "v24"

/**
 * BLS-specific tokenizer — deliberately NOT ranking.ts's shared tokenize(), which turns every
 * non-letter character (hyphens included) into a token boundary. That conflates two different
 * things in BLS names: the comma/slash BLS itself uses to separate a base food from its
 * preparation state ("Kartoffel geschält, roh") vs. a hyphen joining a composite DISH name
 * ("Kartoffel-Tomaten-Gratin mit Mozzarella" — a casserole, not plain potato). Splitting on
 * hyphens too let a bare "Kartoffel" query prefix-match that gratin dish outright (found live via
 * a state-mismatch smoke test). Keeping hyphens fused into their token avoids it, while comma/
 * slash/parens still split exactly like BLS's own state-qualifier syntax.
 *
 * Uses normalizeGermanText(), not .normalize("NFKD") — NFKD decomposes "ö" into "o" + a combining
 * diaeresis, which the old `.replace(/\p{M}/gu, "")` step then silently deleted, corrupting
 * "Gewürz" into "gewrz"-shaped garbage instead of one coherent token. See text-normalize.ts.
 */
function tokenizeBls(s: string): string[] {
  return normalizeGermanText(s)
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
}

/**
 * Local BLS 4.0 Open Data reference table. Source: Max Rubner-Institut (MRI),
 * "Bundeslebensmittelschlüssel (BLS), Version 4.0 - Deutsche Nährstoffdatenbank" (2025-12-15),
 * licensed CC BY 4.0. Required attribution (also in README and resources/bls/bls-4.0.sqlite's
 * bls_meta table):
 *   Max Rubner-Institut (2025): Bundeslebensmittelschlüssel (BLS), Version 4.0 -
 *   Deutsche Nährstoffdatenbank. Karlsruhe. DOI: 10.25826/Data20251217-134202-0
 * Built by scripts/import_bls.py from the official export — every stored value is a verbatim
 * (unit-converted where noted) BLS figure; nothing here is hand-authored or estimated.
 */

interface BlsFoodRecord {
  blsCode: string
  nameDe: string
  nameDeNormalized: string
  nameEn: string | null
  inferredState: FoodState
  /**
   * 1 for the curated raw/base-INGREDIENT subset (resources/bls/ingredient-codes-2992.txt: BLS
   * groups B-W, X/Y menu components excluded, cooking-state variants dropped). Used ONLY as the
   * candidate pool for degraded-mode fuzzy matching — never as a healthy-mode ranking bonus, since
   * the curation is icon-driven and keeps arbitrary variants within a food.
   */
  ingredientPreferred: boolean
  /**
   * Derived from the OFFICIAL BLS Code's leading letter (scripts/import_bls.py) — X/Y are BLS's
   * own documented "Menükomponenten" (menu component/composite dish) groups. This is the
   * PRIMARY, authoritative signal for rejecting a composite dish against a simple query — see
   * foodTypeConflict() in ranking.ts. Every letter other than X/Y maps to "simple" here; BLS's
   * own letter system doesn't further split those into simple vs. processed at this level.
   */
  foodType: FoodType
  nutrients: NutrientSet
  /** Ordered token sequences (not just sets) — needed for prefix-match scoring, see scoreOne(). */
  tokensDe: string[]
  /** Tokenized synonym spellings — see blsNameAlternates(). */
  alternateTokensDe: string[][]
  tokensEn: string[]
  /** Derived once from name_de at load time — inferAttributesFromName() is pure, and recomputing it
   *  for all 7,140 records on every query made the fuzzy stage measurably slower. */
  attributes: FoodAttributes
  plantPart: PlantPart | null
  /** name_de with qualifiers/numbers stripped — the record's bare identity, precomputed at load. */
  identityTokens: string[]
}

interface BlsData {
  records: BlsFoodRecord[]
  /** The ingredient_preferred subset — the degraded-mode fuzzy candidate pool. */
  preferredRecords: BlsFoodRecord[]
  byNormalizedNameDe: Map<string, BlsFoodRecord[]>
  byCode: Map<string, BlsFoodRecord>
  preferredCodes: Set<string>
}

function defaultDbPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url))
  return path.join(here, "../../../resources/bls/bls-4.0.sqlite")
}

let loadPromise: Promise<BlsData | null> | null = null

async function loadBlsData(): Promise<BlsData | null> {
  const dbPath = config.bls.dbPath || defaultDbPath()

  if (!fs.existsSync(dbPath)) {
    logger.warn({ dbPath }, "BLS reference database not found — BLS provider disabled for this run")
    return null
  }

  const SQL = await initSqlJs()
  const buffer = fs.readFileSync(dbPath)
  const db = new SQL.Database(buffer)

  const records: BlsFoodRecord[] = []
  const stmt = db.prepare(`SELECT bls_code, name_de, name_de_normalized, name_en, inferred_state,
    food_type, ingredient_preferred,
    kcal_per_100g, protein_per_100g, carbs_per_100g, fat_per_100g, saturated_fat_per_100g,
    unsaturated_fat_per_100g, fiber_per_100g, sugar_per_100g, sodium_per_100g, cholesterol_per_100g
    FROM bls_foods`)

  try {
    while (stmt.step()) {
      const row = stmt.getAsObject() as Record<string, unknown>
      const nameDe = row.name_de as string
      const nameEn = (row.name_en as string | null) ?? null
      const tokensDe = tokenizeBls(nameDe)
      records.push({
        blsCode: row.bls_code as string,
        nameDe,
        nameDeNormalized: row.name_de_normalized as string,
        nameEn,
        inferredState: row.inferred_state as FoodState,
        ingredientPreferred: Number(row.ingredient_preferred ?? 0) === 1,
        foodType: row.food_type as FoodType,
        nutrients: {
          kcalPer100g: row.kcal_per_100g as number | null,
          proteinPer100g: row.protein_per_100g as number | null,
          carbsPer100g: row.carbs_per_100g as number | null,
          fatPer100g: row.fat_per_100g as number | null,
          saturatedFatPer100g: row.saturated_fat_per_100g as number | null,
          // BLS 4.0 has no total-trans-fat component (only a single named conjugated-linoleic-acid
          // isomer, which isn't the same thing) — always unknown from this provider, never 0.
          transFatPer100g: null,
          unsaturatedFatPer100g: row.unsaturated_fat_per_100g as number | null,
          fiberPer100g: row.fiber_per_100g as number | null,
          sugarPer100g: row.sugar_per_100g as number | null,
          sodiumPer100g: row.sodium_per_100g as number | null,
          cholesterolPer100g: row.cholesterol_per_100g as number | null,
        },
        tokensDe,
        alternateTokensDe: blsNameAlternates(nameDe).map(tokenizeBls),
        tokensEn: tokenizeBls(nameEn ?? ""),
        attributes: inferAttributesFromName(nameDe),
        plantPart: standalonePlantPart(nameDe),
        // Reuses tokensDe rather than re-tokenizing: this runs 7,140 times at startup.
        identityTokens: identityTokens(tokensDe),
      })
    }
  } finally {
    stmt.free()
    db.close()
  }

  const byNormalizedNameDe = new Map<string, BlsFoodRecord[]>()
  for (const r of records) {
    const list = byNormalizedNameDe.get(r.nameDeNormalized)
    if (list) list.push(r)
    else byNormalizedNameDe.set(r.nameDeNormalized, [r])
  }

  const preferredRecords = records.filter((r) => r.ingredientPreferred)
  const preferredCodes = new Set(preferredRecords.map((r) => r.blsCode))

  logger.info(
    { count: records.length, ingredientPreferred: preferredRecords.length, dbPath },
    "Loaded BLS 4.0 reference database",
  )
  return { records, preferredRecords, byNormalizedNameDe, byCode: new Map(records.map((r) => [r.blsCode, r])), preferredCodes }
}

/**
 * A positive cache entry must not be allowed to bypass the degraded two-stage policy. The stored
 * match may have been accepted in healthy mode, where the full pool and the semantic gates were
 * both available; under the degraded policy it is only acceptable if it would still be reachable —
 * i.e. it is in the curated ingredient pool (stage 2), or its BLS name still exactly equals one of
 * this query's German texts with a compatible state (stage 1).
 *
 * Everything needed is re-derivable from the stored providerId/productName, so no extra column is
 * persisted and no field is bolted onto the positive cache key — the same revalidate-don't-widen
 * decision made for M2.
 */
function degradedCacheConflict(
  cached: ProviderMatch,
  data: BlsData,
  queryTexts: string[],
  queryState: FoodState,
): string | null {
  if (cached.providerId && data.preferredCodes.has(cached.providerId)) return null

  const record = data.records.find((r) => r.blsCode === cached.providerId)
  if (record) {
    const exact = queryTexts.some((t) => normalizeKey(t) === record.nameDeNormalized)
    // "unknown" must NOT reject on its own: degraded classification is precisely the case where
    // state information is unavailable, and rejecting there would discard correct exact rows.
    const stateOk = queryState === "unknown" || record.inferredState === "unknown" || record.inferredState === queryState
    if (exact && stateOk) return null
  }

  return `degraded BLS policy: cached match "${cached.productName}" is neither an ingredient-preferred record nor an exact German name match for this query`
}

function getBlsData(): Promise<BlsData | null> {
  if (!loadPromise) loadPromise = loadBlsData()
  return loadPromise
}

/** Test-only: forces the next lookup to reload (and lets tests inject a fresh in-memory dataset). */
export function __resetBlsDataForTests(promise?: Promise<BlsData | null> | null): void {
  loadPromise = promise ?? null
}

export interface TestBlsFoodInput {
  blsCode: string
  nameDe: string
  nameEn?: string | null
  ingredientPreferred?: boolean
  inferredState?: FoodState
  /** Defaults to "simple" — pass "composite_dish" to simulate an X/Y-coded BLS entry in tests. */
  foodType?: FoodType
  nutrients: NutrientSet
}

/**
 * Test-only: builds the same in-memory shape loadBlsData() produces from the real SQLite file,
 * from a small hand-written list of records — lets provider-logic tests (fuzzy scoring, state
 * rejection, missing-nutrient handling) run against deterministic fixtures instead of depending
 * on exactly what the real 7,140-row BLS export happens to contain.
 */
export function __buildTestBlsData(inputs: TestBlsFoodInput[]): BlsData {
  const records: BlsFoodRecord[] = inputs.map((input) => ({
    blsCode: input.blsCode,
    nameDe: input.nameDe,
    nameDeNormalized: normalizeKey(input.nameDe),
    nameEn: input.nameEn ?? null,
    inferredState: input.inferredState ?? "unknown",
    // Fixtures default to preferred so existing provider tests keep one pool; a test that needs a
    // non-preferred row (e.g. a composite only reachable via the exact-match stage) sets it false.
    ingredientPreferred: input.ingredientPreferred ?? true,
    foodType: input.foodType ?? "simple",
    nutrients: input.nutrients,
    tokensDe: tokenizeBls(input.nameDe),
    alternateTokensDe: blsNameAlternates(input.nameDe).map(tokenizeBls),
    tokensEn: tokenizeBls(input.nameEn ?? ""),
    attributes: inferAttributesFromName(input.nameDe),
    plantPart: standalonePlantPart(input.nameDe),
    identityTokens: identityTokens(tokenizeBls(input.nameDe)),
  }))

  const byNormalizedNameDe = new Map<string, BlsFoodRecord[]>()
  for (const r of records) {
    const list = byNormalizedNameDe.get(r.nameDeNormalized)
    if (list) list.push(r)
    else byNormalizedNameDe.set(r.nameDeNormalized, [r])
  }

  const preferredRecords = records.filter((r) => r.ingredientPreferred)
  return { records, preferredRecords, byNormalizedNameDe, byCode: new Map(records.map((r) => [r.blsCode, r])), preferredCodes: new Set(preferredRecords.map((r) => r.blsCode)) }
}

/**
 * LEMMA synonyms: cases where BLS files an everyday food under a different standard German word,
 * so no amount of fuzzy matching can reach it — the two words share no morphology at all.
 *
 * Deliberately NOT a general "make matching looser" list, and deliberately NOT per-ingredient
 * tuning: the bar for an entry is that BLS demonstrably contains the food under a different
 * LEMMA for the SAME thing, verified against the shipped database. Everything else — varieties,
 * qualifiers, plurals, compounds — is handled structurally and must stay that way.
 *
 *   Nudeln/Pasta -> Teigwaren   BLS files all pasta as "Teigwaren" (E401000 "Teigwaren eifrei,
 *                               roh", 346 kcal). A "Nudeln" query could only ever reach
 *                               "Reisnudeln" (rice noodles), the one entry that happens to
 *                               contain the word.
 *   Ghee         -> Butterschmalz   Q683000, 897 kcal. "Ghee" appears nowhere in BLS, so the
 *                               ingredient fell through to an LLM estimate.
 * Verified against the shipped table, the bar keeps the list short: "Essig", "Hefe", "Ketchup",
 * "Zucker" and "Mehl" are all absent from BLS as bare lemmas too, but each is reachable through an
 * ordinary compound of itself ("Apfelessig", "Backhefe", "Tomatenketchup", "Puderzucker",
 * "Lupinenmehl"), so they need the sub-variety policy in lookup(), not a synonym.
 *
 * Applied as ADDITIONAL query variants, never as replacements — the original text is still tried
 * first, so a synonym can only ever add reach, never redirect a query that already worked.
 */
const BLS_LEMMA_SYNONYMS: Record<string, string> = {
  nudeln: "Teigwaren",
  nudel: "Teigwaren",
  pasta: "Teigwaren",
  ghee: "Butterschmalz",
  butterfett: "Butterschmalz",
}

function blsLemmaSynonym(text: string | null | undefined): string | null {
  if (!text) return null
  const key = normalizeGermanText(text).replace(/[^\p{L}\p{N}]/gu, "")
  return BLS_LEMMA_SYNONYMS[key] ?? null
}

function jaccard(a: string[], b: string[]): number {
  const setA = new Set(a)
  const setB = new Set(b)
  if (setA.size === 0 || setB.size === 0) return 0
  let intersection = 0
  for (const t of setA) if (setB.has(t)) intersection++
  const union = setA.size + setB.size - intersection
  return union === 0 ? 0 : intersection / union
}

function isOrderedPrefix(prefix: string[], full: string[]): boolean {
  if (prefix.length === 0 || prefix.length > full.length) return false
  return prefix.every((t, i) => full[i] === t)
}

/**
 * Name-similarity score in [0, 1] for one query-vs-BLS-name comparison, tuned to German
 * compounding rather than reused blindly from ranking.ts's raw substring-containment approach
 * (which was tried first and rejected — see git history / PR discussion: it scored "Salz" against
 * the unrelated "Salzstangen" (pretzel sticks) exactly as high as "Kartoffel" against the
 * legitimate "Kartoffel geschält, roh", since both are plain substring matches).
 *
 * 1. Ordered token-sequence prefix (e.g. "Kartoffel" -> "Kartoffel geschält, roh") — strongest
 *    signal, a real word-boundary match. German-name-only (see `allowPrefixSuffix`).
 * 2. Single-token *suffix* match (e.g. "Zwiebel" -> "Speisezwiebel", "Salz" -> "Speisesalz") —
 *    German compounds are right-headed (the base/head word is the final morpheme), so this
 *    catches the very common bare-generic-word-vs-BLS-compound case precisely, while naturally
 *    rejecting the Salzstangen case ("Salzstangen" does NOT end in "salz" — it starts with it).
 *    A length-ratio guard avoids a short query getting credit for a wildly longer compound.
 *    German-name-only (see `allowPrefixSuffix`).
 * 3. Token-set Jaccard overlap as a general fallback (reordered/partial multi-word queries) —
 *    the only rule ever applied to BLS's English names.
 *
 * `allowPrefixSuffix` gates rules 1-2 to the German name only. BLS's English translations don't
 * follow the disciplined "base food, comma/slash-separated state qualifier" convention its German
 * names do — they're free-form phrases where the first word legitimately matching the query
 * doesn't mean the candidate IS that food. Found live: "Ei" (egg) prefix-matched "Egg pasta raw"
 * (English name of an egg-CONTAINING pasta, not egg), and "Paprika" prefix-matched "Paprika bacon
 * sausage" the same way — both structurally identical to the legitimate "Kartoffel" -> "Kartoffel
 * geschält, roh" case in form, but wrong in substance, because English noun phrases don't carry
 * BLS's German qualifier-comma convention that rules 1-2 were designed around.
 */
/**
 * BLS names are verbose and qualifier-heavy ("Chester (Cheddar) mind. 45 % Fett i. Tr."). Raw
 * jaccard therefore punishes a perfect identity hit simply for the record being descriptive: a
 * "Cheddar" query scored 1/7 there. Identity comparison uses only tokens that actually name a
 * food — qualifiers and numbers are what the descriptor vocabulary already classifies as "not a
 * different food", so they must not dilute similarity either.
 */
/**
 * BLS spells synonyms two ways: "Karotte/Möhre, roh" and "Chester (Cheddar) mind. 45 % Fett i.
 * Tr.". Treating those alternates as ADDITIONAL content made a perfect hit look diluted — a
 * "Cheddar" query scored 36 against the record literally named Cheddar, because "Chester" counted
 * as a different food. Each alternate is scored separately and the best one wins, which is what
 * the notation actually means.
 */
export function blsNameAlternates(name: string): string[] {
  const parenthesised = [...name.matchAll(/\(([^)]+)\)/g)].map((m) => m[1])
  const withoutParens = name.replace(/\([^)]*\)/g, " ")
  const slashParts = withoutParens.split("/").map((p) => p.trim()).filter(Boolean)
  const base = slashParts.length > 1 ? slashParts : [withoutParens]
  // Each parenthesised synonym also stands in for the head noun it qualifies.
  const combined = parenthesised.flatMap((alt) => base.map((b) => b.replace(/^\s*\S+/, alt)))
  // Parenthesised text is only a SYNONYM when it reads like a food NAME. BLS also parenthesises
  // classification codes ("(S X)") and, crucially, qualifier PHRASES: "Pilzcremesuppe aus
  // Instantpulver (mit Wasser zubereitet)". Accepting that phrase as an alternate name let the
  // candidate be judged as "mit Wasser zubereitet" — a string containing no "suppe" — so the
  // composite-dish category gate never fired and a mushroom soup stayed a live candidate for plain
  // water. A real BLS synonym is one word ("(Cheddar)", "(Gewürzgurke)", "(Frischbackhefe)"),
  // occasionally two; a phrase is not a name.
  //
  // A leading function word is the giveaway that the parentheses hold a QUALIFIER rather than a
  // name — and inverting ones especially: "Gemüse-Meerrettich (ohne Salz)" is horseradish WITHOUT
  // salt, yet as an alternate name "ohne Salz" made it a live candidate for plain salt, because the
  // core-identity gate could see "Salz" in it.
  const MAX_SYNONYM_WORDS = 2
  const QUALIFIER_OPENERS = new Set(["mit", "ohne", "in", "im", "aus", "und", "von", "zum", "zur", "als", "auf", "je"])
  const looksLikeName = (s: string) => {
    const words = s.trim().split(/\s+/)
    if (words.length > MAX_SYNONYM_WORDS || !/\p{L}{3,}/u.test(s)) return false
    return !QUALIFIER_OPENERS.has(normalizeGermanText(words[0]).replace(/[^\p{L}]/gu, ""))
  }
  return [...new Set([...base, ...parenthesised, ...combined].map((s) => s.trim()).filter((s) => s && looksLikeName(s)))]
}

function identityTokens(tokens: string[]): string[] {
  const kept = tokens.filter((t) =>
    t.length >= 3 && !/^\d/.test(t) &&
    !GENERIC_DESCRIPTOR_WORDS.has(t) && !GERMAN_DESCRIPTOR_WORDS.has(t))
  return kept.length > 0 ? kept : tokens
}

function nameScore(queryTokens: string[], candidateTokens: string[], allowPrefixSuffix: boolean): number {
  const qId = identityTokens(queryTokens)
  const cId = identityTokens(candidateTokens)

  if (!allowPrefixSuffix) {
    return jaccard(qId, cId) * 0.7
  }

  if (isOrderedPrefix(queryTokens, candidateTokens) || isOrderedPrefix(qId, cId)) return 0.85
  // Containment bonuses require the query to explain MOST of the record. Without that guard a
  // one-word query matched any dish that merely listed it among other foods — "Koriander" vs
  // "Rote-Linsensuppe mit Koriander" — which an existing regression test guards against.
  const explainsRecord = cId.length <= qId.length + 1

  if (explainsRecord && qId.length > 0 && cId.length > 0 && germanTokenMatches(qId[0], cId[0])
    && qId.every((q) => cId.some((c) => germanTokenMatches(q, c)))) return 0.85

  // The record literally contains every identity word the query asked for (e.g. "Cheddar" inside
  // "Chester (Cheddar) …"). That is strong evidence regardless of how many synonyms or qualifiers
  // the record carries alongside it.
  if (explainsRecord && qId.length > 0 && qId.every((q) => cId.some((c) => germanTokenMatches(q, c)))) return 0.8

  // A minimum query length guards against coincidental endings: found live, "Ei" (egg, 2 letters)
  // matched "Teigwaren eifrei, roh" (EGG-FREE pasta) because "eifrei" happens to end in "ei" for
  // an unrelated reason (the German negation suffix "-frei" itself ends in "-ei", as do many
  // unrelated common words: Bäckerei, Brauerei, Molkerei, ...). Below this length, a coincidental
  // trailing-letter match is more likely than genuine compounding, and the risk is asymmetric —
  // an inverted/unrelated nutrition profile is worse than a missed match falling through to the
  // next provider. This does cost some legitimate short-word matches (e.g. "Ei" -> "Hühnerei"
  // roh, a real compound) but that trade favors safety, consistent with the conservative-fuzzy-
  // threshold requirement.
  const MIN_QUERY_LENGTH_FOR_SUFFIX_MATCH = 4

  if (qId.length === 1 && qId[0].length >= MIN_QUERY_LENGTH_FOR_SUFFIX_MATCH) {
    const q = qId[0]
    // Strictly LONGER, not just endsWith: a genuine German compound like "Speisezwiebel" is one
    // fused token strictly longer than its head word "zwiebel". Requiring t.length > q.length
    // (not >=) excludes the trivial t === q case — found live: "Koriander" was matching
    // "Rote-Linsensuppe mit Koriander" (a whole lentil-soup dish) because "koriander" trivially
    // "ends with" itself as a bare standalone token in an unrelated multi-word dish name. That
    // exact-token-among-other-words case is weaker evidence and is left to the jaccard fallback
    // below, which naturally penalizes it via the dish's other, unrelated tokens.
    // The query's own stem is tried alongside it: German compounds carry the SINGULAR head, so a
    // plural query ("Zwiebeln") never ends a compound the way its stem does ("Speise|zwiebel").
    const heads = [q, germanStem(q)].filter((h, i, a) => h.length >= MIN_QUERY_LENGTH_FOR_SUFFIX_MATCH && a.indexOf(h) === i)
    const suffixHit = candidateTokens.find((t) =>
      heads.some((h) => t.length > h.length && t.endsWith(h) && t.length <= h.length + 8))
    if (suffixHit) return 0.6

    // The mirror case: the QUERY is the fused compound and the database spells it as separate
    // words. Found live — "Hähnchenbrust" is one token while BLS has "Hähnchen Brustfilet, roh",
    // so they shared nothing and an exact-quality record was unreachable. Both halves must be
    // evidenced in the candidate, which is what keeps this from becoming substring matching.
    if (compoundMatchesTokens(q, candidateTokens)) return 0.6
  }

  if (qId.length === 1 && compoundMatchesTokens(qId[0], cId)) return 0.6

  return jaccard(qId, cId) * 0.7 // scaled below prefix/suffix — a partial, unordered overlap is the weakest signal of the three
}

interface ScoredRecord {
  record: BlsFoodRecord
  score: number
  mismatchReason: string | null
  matchedViaEnglish: boolean
}

/** Conservative threshold for a *fuzzy* (non-exact-normalized-string) BLS match. Exact matches bypass this entirely. */
const FUZZY_MIN_SCORE = 50

/**
 * `identityText` is the FULL ingredient text (every spelling the classifier produced), used only
 * by the specificity gate. It cannot be `queryText`: the variant list deliberately strips
 * modifiers so a core-only retry can broaden ("Basmati-Reis" -> "Reis"), and that retry was
 * laundering the very identity the gate exists to protect — "Knoblauchgewürz" failed under its own
 * name and then matched "Knoblauch roh" on the core-only pass, which is exactly the live result.
 * What an ingredient IS does not change between variants, so the gate reads the whole text while
 * scoring continues to read one variant at a time.
 */
function scoreCandidates(queryText: string, records: BlsFoodRecord[], category: string | null, queryFoodType: FoodType, queryCoreFood: string | null, attrs = UNKNOWN_ATTRIBUTES, identityText = queryText, identityCore = queryCoreFood): ScoredRecord[] {
  const queryTokens = tokenizeBls(queryText)
  // Ambiguity evidence over the candidate SET — see specificityConflict(). Restricted to records
  // that actually name the queried food, so unrelated entries never manufacture ambiguity; the
  // precomputed plantPart is checked first so only the handful of records that name a part at all
  // pay for the core gate's tokenization.
  const parts = new Set<PlantPart>()
  for (const r of records) {
    if (r.plantPart && !parts.has(r.plantPart)
      && !coreIdentityConflict(queryCoreFood, r.nameDe)
      && sharesFullQueryIdentity(identityText, r.nameDe)) parts.add(r.plantPart)
  }
  return records.map((record) => {
    // PRIMARY check first, before any lexical scoring: the official BLS Code letter (X/Y =
    // composite dish) beats a high textual score every time — see foodTypeConflict() in
    // ranking.ts. The lexical categoryConflict/findMismatch checks below remain as a secondary/
    // defense-in-depth layer (e.g. for the "unknown" foodType case when the LLM is disabled).
    if (foodTypeConflict(queryFoodType, record.foodType)) {
      return {
        record,
        score: -1000,
        mismatchReason: `food type conflict: a "${queryFoodType}" query cannot accept BLS's composite-dish entry "${record.nameDe}" (${record.blsCode})`,
        matchedViaEnglish: false,
      }
    }

    // Score against every synonym spelling BLS offers and keep the best — and remember WHICH
    // spelling won, so the identity gates below judge the same text the score came from.
    const deVariants: [string, string[]][] = [
      [record.nameDe, record.tokensDe],
      ...blsNameAlternates(record.nameDe).map((n, i) => [n, record.alternateTokensDe[i]] as [string, string[]]),
    ]
    // On a TIE, the spelling with the fewest identity words wins. BLS writes synonym sets as
    // "A/B/C", and blsNameAlternates() splits them so scoring can judge one name at a time — but
    // the winning SPELLING is also what every downstream gate and the score adjustment judge, and
    // the undivided string ties with its own parts. "Speisesalz/Siedesalz/Tafelsalz" therefore got
    // charged 35 points of foreign content for "Siedesalz" while matching on "Speisesalz", which
    // dropped the correct salt record from 57 to 22 against a threshold of 50. Preferring the
    // narrower spelling makes the alternates do the job they exist for.
    let scoreDe = -Infinity
    let bestDeName = record.nameDe
    let bestDeWords = Infinity
    for (const [name, toks] of deVariants) {
      const sc = nameScore(queryTokens, toks, true)
      const words = identityTokens(toks).length
      if (sc > scoreDe || (sc === scoreDe && words < bestDeWords)) {
        scoreDe = sc
        bestDeName = name
        bestDeWords = words
      }
    }
    const scoreEn = nameScore(queryTokens, record.tokensEn, false)
    const matchedViaEnglish = scoreEn > scoreDe
    const best = Math.max(scoreDe, scoreEn)
    const candidateName = matchedViaEnglish ? (record.nameEn ?? "") : bestDeName

    // Second PRIMARY signal, alongside foodTypeConflict — see coreIdentityConflict() in
    // ranking.ts. Shared with OFF/USDA rather than a separate BLS-specific implementation.
    // Attribute gates rank with foodTypeConflict as PRIMARY signals — a fresh/ground or
    // canned/dried or fat-class difference is a different food, not a weaker text match.
    const ca = record.attributes
    const attrReason =
      formConflict(attrs.form, ca.form) || freshVsProcessedFormConflict(attrs.preservation, ca.form)
        ? `form conflict: a "${attrs.form}" query cannot accept a "${ca.form}" BLS entry ("${record.nameDe}")`
      : preservationConflict(attrs.preservation, ca.preservation)
        ? `preservation conflict: a "${attrs.preservation}" query cannot accept a "${ca.preservation}" BLS entry ("${record.nameDe}")`
      : fatConflict(attrs.fatPercent, record.nutrients.fatPer100g)
        ? `fat conflict: ${attrs.fatPercent}% requested, "${record.nameDe}" has ${record.nutrients.fatPer100g}g/100g`
      : null

    const mismatchReason = attrReason ?? (coreIdentityConflict(queryCoreFood, candidateName)
      ? `core identity conflict: "${queryCoreFood}" is absent from candidate name ("${candidateName}")`
      : null)
      // Same asymmetric-specificity gate the network providers use — a query naming a seasoning or
      // a brine must not take the raw food, and an ambiguous query must not be handed one part of
      // a plant the database offers several of.
      ?? specificityConflict(identityText, identityCore, attrs, candidateName, parts)
      ?? findMismatch(queryText, candidateName) ?? (categoryConflict(category, candidateName) ? `category conflict: "${category}" vs "${candidateName}"` : null)

    let score = best * 70
    score += coreIdentityScoreAdjustment(queryCoreFood, queryText, candidateName)
    score += record.nutrients.kcalPer100g !== null ? 15 : -50
    if (mismatchReason) score -= 1000

    return { record, score, mismatchReason, matchedViaEnglish }
  })
}


/**
 * Picks the best acceptable candidate from a scored, sorted list, preferring one whose inferred
 * ATTRIBUTES answer what the query asked for (see attributeFit) and whose inferred preparation
 * state agrees with the query's structured state. A top candidate whose state is *known* and
 * *conflicts* with the query's known state is never accepted outright — the skill's "reject
 * candidate, don't guess" rule — but a same-score-band candidate with the right state is tried
 * first, and a candidate with *unknown* inferred state (BLS's name didn't say) is never treated as
 * a conflict either way.
 */
/**
 * Whether a match may be written to the persistent provider cache.
 *
 * The cache is read before any scoring, so anything stored here is replayed verbatim on every
 * later request for this query. Storing a record the resolver will reject therefore does not
 * merely waste a row — it makes the rejection permanent, and immune to any later improvement in
 * matching. v1.0.1 cached "Obstbrand/Obstwasser" for "Wasser"; v1.0.2 fixed the selection that
 * chose it and still replayed it from disk, because the fix was never reached.
 *
 * The resolver keeps the final word. This only decides what is allowed to persist.
 */
function cacheable(match: ProviderMatch, queryFoodName: string): boolean {
  const check = sanityCheckNutrients(match.nutrients, queryFoodName)
  if (check.ok) return true
  logger.warn(
    { provider: "bls", foodName: queryFoodName, record: match.productName, providerId: match.providerId, reason: check.reason },
    "Refusing to cache a BLS match that is not nutritionally possible for this ingredient",
  )
  return false
}

function pickBestCandidate(sorted: ScoredRecord[], queryState: FoodState, minScore: number, queryAttrs = UNKNOWN_ATTRIBUTES, identityText = "", sanityName = ""): ScoredRecord | null {
  // Nutritional plausibility is part of SELECTION, not just a veto applied afterwards.
  //
  // The resolver sanity-checks whatever a provider returns, but a failure there discards the whole
  // PROVIDER: the chain moves on, and every remaining candidate this provider had — including a
  // perfectly good one at the same score — is never considered. "Wasser" is what exposed it. BLS
  // holds Trinkwasser (N110000, 0 kcal) and Obstbrand/Obstwasser (P752100, 274 kcal, a fruit
  // schnapps); German compounds them identically, so both score 57 and the tie fell to the
  // schnapps. The resolver then rejected 274 kcal for "Wasser" — correctly — and left the
  // ingredient unresolved, which withheld the entire recipe's nutrition, with 0 kcal water sitting
  // one position down the list.
  //
  // So the same check runs here, against the same query name the resolver will use, while the
  // alternatives are still in hand. A candidate whose numbers cannot be true for the food that was
  // asked for is not a candidate. This does not weaken the resolver's check — that still runs, and
  // still has the final word.
  const acceptable = sorted.filter((c) =>
    c.score >= minScore
    && !c.mismatchReason
    && (!sanityName || sanityCheckNutrients(c.record.nutrients, sanityName).ok))
  if (acceptable.length === 0) return null

  // Within one score band, attribute fit decides before raw score does — a two-point lexical edge
  // must not outrank actually answering the question that was asked. Sort is stable, so equal fit
  // preserves the existing score order.
  const ATTRIBUTE_BAND = 20
  const bandTop = acceptable[0].score - ATTRIBUTE_BAND
  const banded = acceptable.filter((c) => c.score >= bandTop)
  const rest = acceptable.filter((c) => c.score < bandTop)
  const bandOrdered = [...banded].sort((a, b) =>
    (attributeFit(queryAttrs, b.record) - unmetModifierPenalty(identityText, b.record.nameDe) / UNMET_MODIFIER_WEIGHT)
    - (attributeFit(queryAttrs, a.record) - unmetModifierPenalty(identityText, a.record.nameDe) / UNMET_MODIFIER_WEIGHT))

  // A preparation state the INGREDIENT TEXT STATES is EVIDENCE, not merely a veto.
  //
  // Below, an explicit query state only ever rejects a candidate that actively CONTRADICTS it —
  // and `unknown` contradicts nothing, so a record BLS never labelled satisfies "cooked" as
  // happily as one labelled "gekocht". "Cooked Puy Lentils" is what exposed it: the core-only
  // variant "Linsen" ties three records at 75, and the dry Linse reif (H725100, state unknown,
  // 323 kcal) sits first, so the tied Linse reif, gekocht (H730132, state cooked, 119 kcal) — an
  // exact state match at the same score — was never reached. Roughly a 3x error, silently.
  //
  // The evidence is read from the TEXT, not from query.state, and that distinction is the whole
  // safety of this rule. reconcileState() refuses an unevidenced "cooked"/"dried" but deliberately
  // lets an unevidenced "raw" through, because until now state was only ever a veto and a veto
  // nobody contradicts costs nothing. Measured on the frozen corpus, 110 of 122 non-unknown states
  // are exactly that: an unevidenced "raw" the classifier emits as a null value, on Salz, Zucker,
  // Mehl, Essig, Parmesan and Wasser alike. Promoting on those turns a null into an assertion, and
  // it does real damage — "Milch (Vollmilch)" carries state "raw" with no word supporting it, and
  // BLS's M112300 "Rohmilch/Vorzugsmilch" is CORRECTLY labelled raw, so an exact-state promotion
  // moves pasteurised whole milk to unpasteurised. Both sides are right; the state is not evidence.
  //
  // So: promote only on a state some word in the text actually claims. Confined to the band, so a
  // low-scoring candidate can never jump a materially better one; stable, so candidates equal on
  // state keep the attribute ordering above; and skipped entirely when the text states nothing —
  // which is every deterministic query and all but twelve of the AI ones.
  //
  // queryState is deliberately untouched here: the conflict veto below still uses the reconciled
  // state, so nothing this rule declines to promote loses the protection it already had.
  const evidencedState = statedPreparation(identityText)
  const statePreferred = evidencedState === "unknown" ? bandOrdered : [
    ...bandOrdered.filter((c) => c.record.inferredState === evidencedState),
    ...bandOrdered.filter((c) => c.record.inferredState !== evidencedState),
  ]

  const ordered = [...statePreferred, ...rest]

  const top = ordered[0]
  const topConflicts = queryState !== "unknown" && top.record.inferredState !== "unknown" && top.record.inferredState !== queryState

  if (!topConflicts) return top

  // Look for a same-band alternative (within 20 points of the top score) whose state doesn't
  // conflict. queryState is provably not "unknown" here (topConflicts required it above). An
  // explicit state match is preferred outright over one BLS's name simply didn't specify — two
  // separate passes, not one combined predicate, so "unknown" never outranks a real match found
  // later in score order.
  const band = top.score - 20
  const inBand = ordered.filter((c) => c.score >= band)
  const exactStateMatch = inBand.find((c) => c.record.inferredState === queryState)
  if (exactStateMatch) return exactStateMatch
  return inBand.find((c) => c.record.inferredState === "unknown") ?? null
}


/**
 * RECALL-only retrieval: records whose German name contains the query's core anywhere, including
 * as a compound PREFIX. Deterministic scoring deliberately cannot do this (it is how "Salz" once
 * matched "Salzstangen"), so these records are reachable only as rerank candidates, and only after
 * the same hard gates every other candidate passes.
 */
function recallCandidates(query: ProviderQuery, data: BlsData, attrs: FoodAttributes): ScoredRecord[] {
  const core = (query.coreFoodGerman ?? query.structuredName ?? "").trim()
  const needle = normalizeGermanText(core).replace(/[^\p{L}\p{N}]/gu, "")
  if (needle.length < MIN_RECALL_CORE_LENGTH) return []

  const hits = data.records.filter((r) => r.nameDeNormalized.includes(needle))
  if (hits.length === 0 || hits.length > MAX_RECALL_HITS) return []

  return scoreCandidates(
    core, hits, query.category, query.foodType, query.coreFoodGerman ?? null, attrs,
    [query.structuredName, query.canonicalGerman, query.foodName].filter(Boolean).join(" "),
    query.coreFoodGerman ?? null,
  ).filter((c) => !c.mismatchReason)
}

/** Below this a core token is too short for substring recall to mean anything. */
const MIN_RECALL_CORE_LENGTH = 4
/** A core matching this many records is too generic for recall to be useful; skip rather than guess. */
const MAX_RECALL_HITS = 120

/**
 * Ceiling on a reranked match's confidence. The record was chosen by a judge rather than earned by
 * lexical score, so reporting the score would be doubly wrong: "Petersilienblatt" scores 15 because
 * the scorer cannot see the query inside it at all, and calling that 0.15 confidence would flag a
 * correct record as doubtful. Capped below an exact name match, which remains the strongest signal.
 */
const RERANK_MAX_CONFIDENCE = 0.8

/**
 * Confidence for a fuzzy match, from SEMANTIC evidence rather than lexical score.
 *
 * The old formula was `score / 100`, which reported "Hähnchen Brustfilet, roh", "Speisezwiebel roh"
 * and "Speisesalz/Siedesalz/Tafelsalz" — three unambiguously correct records — at 0.57, and so
 * dragged whole recipes to `matchQuality: low` while the LLM reranker was handing 0.9 to a wrong
 * one. A BLS name carrying a prefix the query lacks ("Speise|zwiebel") is a fact about German
 * compounding, not doubt about identity.
 *
 * What is actually being asserted here is: every hard gate passed, the classifier's core noun was
 * present, and the lexical score cleared a deliberately conservative threshold. That is strong
 * evidence. The score still separates a comfortable match from a marginal one, and an ingredient
 * with no core evidence at all (classifier down) stays low however well its name happens to read.
 */
const CONFIDENCE_COMFORTABLE_SCORE = FUZZY_MIN_SCORE + 20

function semanticConfidence(score: number, hasCoreEvidence: boolean): number {
  if (!hasCoreEvidence) return Math.min(0.6, score / 100)
  return score >= CONFIDENCE_COMFORTABLE_SCORE ? 0.85 : 0.75
}

/** Ceiling for a match that drops a stated nutritional claim — deliberately below the
 *  low-confidence threshold, so the recipe's match quality reports it. */
const UNMET_ATTRIBUTE_CONFIDENCE_CAP = 0.55

function buildMatch(query: ProviderQuery, scored: ScoredRecord, isExact: boolean, rerank?: { reason: string; confidence: number }, identityText = ""): ProviderMatch {
  const unmet = unmetModifierFamilies(identityText || query.structuredName || query.foodName, scored.record.nameDe)
  const base = isExact
    ? 0.92
    : rerank
      ? Math.min(RERANK_MAX_CONFIDENCE, rerank.confidence)
      : semanticConfidence(scored.score, Boolean(query.coreFoodGerman?.trim()))
  // A record that does not answer a claim the ingredient made is not an equivalent match, however
  // well its name scores. Capping below LOW_CONFIDENCE_THRESHOLD is what makes the shortfall
  // visible in match quality instead of only in provenance — see UNMET_ATTRIBUTE_CONFIDENCE_CAP.
  const confidence = unmet.length > 0 ? Math.min(base, UNMET_ATTRIBUTE_CONFIDENCE_CAP) : base
  return {
    nutrients: scored.record.nutrients,
    canonicalName: query.foodName,
    brand: null,
    state: query.state,
    provider: "bls",
    providerId: scored.record.blsCode,
    productName: scored.matchedViaEnglish && scored.record.nameEn ? `${scored.record.nameDe} (${scored.record.nameEn})` : scored.record.nameDe,
    confidence,
    foodType: scored.record.foodType,
    matchReason: isExact ? "exact-name" : rerank ? "llm-reranked" : "fuzzy",
    // Provenance: the RECORD was chosen with the model's help, but every nutrient above still
    // comes from this BLS row. `provider` stays "bls" for exactly that reason.
    ...(rerank ? { llmReranked: true as const, rerankReason: rerank.reason } : {}),
    ...(unmet.length > 0 ? { unmetAttributes: unmet } : {}),
  }
}

/**
 * BLS 4.0 provider — the primary local generic-route nutrition source. Matches against the
 * *structured* German Mealie food name first (never originalText), falling back to the LLM
 * batch normalizer's canonicalName only if the raw structured name finds nothing acceptable
 * (covers ambiguous/misspelled wording the normalizer already cleaned up). Exact normalized-name
 * match is preferred outright; fuzzy matching uses the same token-similarity approach as the
 * OFF/USDA providers (ranking.ts) but against an in-memory, precomputed BLS token index rather
 * than a network call.
 */
export class BlsProvider implements NutrientProvider {
  readonly name = "bls"

  async lookup(query: ProviderQuery): Promise<ProviderMatch | null> {
    const data = await getBlsData()
    if (!data) return null

    // Tried in order: raw structured name (highest fidelity), the LLM's normalized German name
    // (catches misspellings/dialect), then the LLM's English translation (last resort, weakened
    // via nameScore's allowPrefixSuffix=false for English candidates). Each variant is paired with
    // the core-identity value in its OWN language — coreFoodGerman for the two German variants,
    // coreFoodEnglish for the English fallback — since coreIdentityConflict() substring-matches
    // against the candidate name in whichever language actually got selected.
    const structuredName = query.structuredName?.trim()
    const canonicalGerman = query.canonicalGerman?.trim()
    // A lemma synonym is queried under its OWN word as the core too — "Teigwaren" is what BLS
    // calls the food, so gating that variant on the core "Nudeln" would reject every candidate.
    const synonyms = [structuredName, canonicalGerman, query.coreFoodGerman, query.foodName]
      .map(blsLemmaSynonym)
      .filter((s): s is string => s !== null)
      .map((text) => ({ text, core: text }))

    const queryVariants = [
      { text: structuredName, core: query.coreFoodGerman ?? null },
      { text: canonicalGerman, core: query.coreFoodGerman ?? null },
      { text: query.foodName, core: query.coreFoodEnglish ?? null },
      // Last resort: the classifier's own modifier-stripped German core. "Basmati-Reis" names a
      // variety BLS does not model, but its core "Reis" reaches the generic rice record — using
      // the base noun we already have rather than inventing a synonym list.
      { text: query.coreFoodGerman ?? null, core: query.coreFoodGerman ?? null },
      // Tried last: only a query that found nothing under its own words falls back to BLS's lemma.
      ...synonyms,
    ].filter((v, i, arr): v is { text: string; core: string | null } => !!v.text && arr.findIndex((o) => o.text === v.text) === i)
    const queryTexts = queryVariants.map((v) => v.text)
    // Every spelling of the ingredient, for the variant-independent specificity gate.
    const identityText = [structuredName, canonicalGerman, query.foodName].filter(Boolean).join(" ")

    // Unlike OFF/USDA, BLS matching is state-sensitive (pickBestByState) — the shared
    // buildQueryKey(foodName, brand) alone would let a "cooked" resolution get wrongly reused for
    // an "unknown"/"raw" query of the same food name. State is folded into the key text itself.
    //
    // BLS_MATCH_ALGORITHM_VERSION is prefixed the same way llmNutrientCacheKey's "v2:" is
    // (cache.ts) — the matching *algorithm* here (nameScore's prefix/suffix/jaccard rules) has
    // already changed twice within one deployment (fixing a trivial-exact-token false positive,
    // then a short-query coincidental-suffix false positive: "Ei" matching "eifrei" = EGG-FREE
    // pasta). provider_match_cache has no other versioning, so a future algorithm fix would
    // otherwise be silently masked by up to CACHE_MATCH_TTL (7 days by default) of stale matches
    // for any ingredient text already resolved once. Bump this string whenever nameScore's
    // matching behavior changes.
    const attrs = query.attributes ?? UNKNOWN_ATTRIBUTES
    // Attributes are part of the POSITIVE key (not merely revalidated) because two queries with the
    // same text and state but different form/preservation/fat are genuinely different questions —
    // "Ingwer" fresh vs ground, "Kochsahne 7%" vs "15%". Revalidation alone could not separate
    // them, since the stored candidate name is identical in both cases.
    const queryKey = buildQueryKey(
      `${BLS_MATCH_ALGORITHM_VERSION}:${queryTexts.join("|")}|${query.state}|${attributesKey(attrs)}`,
      query.brand,
    )
    // category/foodType/coreFood are not part of the positive key by design — re-checked against
    // the stored candidate instead (cachedMatchConflict). The German core is used here because the
    // stored productName always contains BLS's German name (plus its English name only when the
    // match was made via English), so a German core token still resolves against it. The NEGATIVE
    // key does carry the context, since a miss has no stored candidate to re-check.
    const evidence = query.evidence ?? FULL_EVIDENCE
    const degraded = usesDegradedBlsPolicy(evidence)
    const ctx = {
      foodName: query.canonicalGerman ?? query.structuredName ?? query.foodName,
      category: query.category,
      foodType: query.foodType,
      coreFood: query.coreFoodGerman,
      evidence,
      attributes: attrs,
    }
    const missKey = `${queryKey}|ctx=${matchingContextKey(ctx)}`

    const cached = query.poolOnly ? undefined : getCachedProviderMatch(this.name, queryKey)
    if (cached) {
      const conflict = cachedMatchConflict(cached, ctx)
        ?? (degraded ? degradedCacheConflict(cached, data, queryTexts, query.state) : null)
        // A cached record that cannot be true for this food is a poisoned entry, not a hit. It
        // outranks every conflict rule above because it is the one failure that survives its own
        // fix: the cache is consulted before any scoring, so an entry written by an older build
        // is replayed forever and no amount of better ranking is ever reached. Re-score instead.
        ?? (sanityCheckNutrients(cached.nutrients, query.foodName).ok
          ? null
          : `cached record "${cached.productName}" (${cached.providerId}) is not nutritionally possible for "${query.foodName}"`)
      if (!conflict) return cached
      // True cache miss for this context — fall through and re-score against the BLS table, so a
      // different BLS record that IS valid for this context stays reachable.
      logger.info({ foodName: query.foodName, reason: conflict }, "BLS: cached match incompatible with this query's context, re-querying")
    }
    if (!query.poolOnly && isProviderMiss(this.name, missKey)) return null

    // A candidate that narrows the query to a SUB-VARIETY it never named is refused outright, with
    // no relaxed second pass to fall back on.
    //
    // An earlier revision did have one: when no unspecified record existed it accepted the
    // sub-variety at reduced confidence, on the theory that German files most everyday foods only
    // as compounds. Auditing every broadening it actually produced over the 141 live ingredient
    // names killed that theory — the pass accepted "Mehl" -> "Lupinenmehl" (a legume flour: 40 g
    // protein per 100 g against wheat's 10), "Petersilie" -> "Wurzelpetersilie" (a root vegetable,
    // 76 kcal, for a 33 kcal herb) and "Sellerie" -> "Knollensellerie" (celeriac for celery).
    //
    // No lexical rule separates those from the harmless cases, because the difference is about the
    // food rather than the word: measured against BLS, the German prefixes that look like pure
    // manner words are not ("Back|erbsen" is a 469 kcal deep-fried snack against 81 for peas,
    // "Koch|banane" is a plantain, not a banana). Nutritional agreement among sibling records does
    // not separate them either — Lupinenmehl sits within 4% of the median flour by ENERGY, and
    // only its macros give it away.
    //
    // So the specificity rule applies uniformly, and an ingredient BLS cannot answer without
    // guessing falls through to the next provider and then to an LLM estimate. A miss that the
    // fallback chain can answer honestly is worth more than a confident wrong record.
    let deterministic: ScoredRecord | null = null
    const survivors = new Map<string, ScoredRecord>()

    for (const { text, core } of queryVariants) {
      const normalized = normalizeKey(text)
      const exactCandidates = data.byNormalizedNameDe.get(normalized)

      if (exactCandidates && exactCandidates.length > 0) {
        const withKcal = exactCandidates.find((r) => r.nutrients.kcalPer100g !== null) ?? exactCandidates[0]
        const stateOk = query.state === "unknown" || withKcal.inferredState === "unknown" || withKcal.inferredState === query.state
        // Even an exact string match must respect food-type compatibility — the authoritative
        // BLS-code-derived type outranks string equality (a "simple" query whose text happens to
        // exactly equal a composite dish's name is a contradiction worth rejecting, not trusting).
        const typeOk = !foodTypeConflict(query.foodType, withKcal.foodType)
        // An exact NAME match still must not cross a nutritionally meaningful attribute boundary.
        const exactAttrs = withKcal.attributes
        const attrOk = !formConflict(attrs.form, exactAttrs.form)
          && !preservationConflict(attrs.preservation, exactAttrs.preservation)
          && !fatConflict(attrs.fatPercent, withKcal.nutrients.fatPer100g)
        if (stateOk && typeOk && attrOk) {
          const match = buildMatch(query, { record: withKcal, score: 100, mismatchReason: null, matchedViaEnglish: false }, true, undefined, identityText)
          // An exact NAME match still has to be nutritionally possible for the food asked for.
          // This path returns before candidate selection, so it is the one remaining way an
          // impossible record could be persisted and then replayed on every later request.
          if (cacheable(match, query.foodName)) setCachedProviderMatch(this.name, queryKey, match)
          return match
        }
        // Exact name match but conflicting state/type (e.g. query wants "cooked", only a "raw"
        // entry has this exact name) — fall through to fuzzy scoring, which might find a
        // differently *named* but compatible BLS entry (e.g. "Kartoffel gekocht" vs "Kartoffel").
      }

      // STAGE 2 — fuzzy/ranked. Under the degraded policy this is restricted to the curated
      // ingredient pool: the semantic gates that normally police a fuzzy match are unavailable,
      // and the full pool is where "Paprika" silently became "Paprika gedünstet (mit Fett und
      // Salz)" and "Sellerie" became "Sellerie gekocht, mit Sahne". Stage 1 above still searches
      // the FULL pool, so exact German rows outside the curated set (Gemüsebrühe, Hühnerei
      // gekocht, Tomate getrocknet, Sojabohne reif gekocht) remain reachable.
      const pool = degraded ? data.preferredRecords : data.records
      const scored = scoreCandidates(text, pool, query.category, query.foodType, core, attrs, identityText, query.coreFoodGerman ?? null)
        .sort((a, b) => b.score - a.score)
      // Everything that survived the hard gates, kept for a possible rerank. Accumulated across
      // variants because a record unreachable under one spelling may be reachable under another.
      for (const c of scored) {
        if (c.mismatchReason) continue
        const seen = survivors.get(c.record.blsCode)
        if (!seen || c.score > seen.score) survivors.set(c.record.blsCode, c)
      }
      const picked = pickBestCandidate(scored, query.state, FUZZY_MIN_SCORE, attrs, identityText, query.foodName)
      if (picked && !deterministic) deterministic = picked
    }

    // Report the gate survivors to whoever asked (the semantic judge, when the chain is about to
    // fall through to a fabricated estimate). Note WHERE this sits: after the gates, before
    // FUZZY_MIN_SCORE and before pickBestCandidate — so a record this provider will not use on
    // its own, purely because it scored low, is still visible as a real candidate. Nothing that
    // failed a gate is ever in `survivors`.
    if (query.candidateSink && survivors.size > 0) {
      query.candidateSink([...survivors.values()]
        .filter((c) => c.record.nutrients.kcalPer100g !== null)
        .map((c) => ({
          id: `bls:${c.record.blsCode}`,
          provider: "bls",
          providerId: c.record.blsCode,
          name: c.record.nameDe,
          dataType: null,
          brand: null,
          category: null,
          state: c.record.inferredState,
          form: c.record.attributes.form,
          preservation: c.record.attributes.preservation,
          nutrients: c.record.nutrients,
          score: c.score,
        })))
    }

    // A diagnostic pass stops here: the survivors have been reported and nothing else may happen —
    // no rerank (which would spend a second LLM call), no cache write, no miss marker.
    if (query.poolOnly) return null

    // The deterministic answer stands unless this is genuinely an ambiguous case — see
    // shouldRerank(). When it is, the LLM judges between records RETRIEVAL already found and the
    // GATES already approved; it cannot reach anything else, and NONE leaves this line's outcome
    // exactly as it would have been.
    const reranked = await this.maybeRerank(query, data, attrs, deterministic, survivors, identityText)
    const chosen = reranked?.picked ?? deterministic

    if (chosen) {
      const match = buildMatch(query, chosen, false, reranked ?? undefined, identityText)
      if (cacheable(match, query.foodName)) setCachedProviderMatch(this.name, queryKey, match)
      return match
    }

    // Stage 1 and stage 2 both ran and found nothing: a genuine miss FOR THIS EVIDENCE PROFILE.
    // The profile is part of missKey, so this never suppresses a later lookup with better identity.
    markProviderMiss(this.name, missKey)
    return null
  }

  /**
   * Decides whether this lookup is ambiguous enough to be worth an LLM call, and if so runs it.
   *
   * Returns the reranked record, or null meaning "nothing changes". Never throws: every failure
   * inside rerankCandidates() already degrades to null.
   */
  private async maybeRerank(
    query: ProviderQuery,
    data: BlsData,
    attrs: FoodAttributes,
    deterministic: ScoredRecord | null,
    survivors: Map<string, ScoredRecord>,
    identityText: string,
  ): Promise<{ picked: ScoredRecord; reason: string; confidence: number } | null> {
    if (!config.llm.enabled || !config.llm.apiKey || !config.llm.rerankEnabled) return null

    // RECALL pool. Deterministic scoring is
    // tuned for precision and cannot see the query's core inside a longer compound when the core
    // is the PREFIX ("Petersilie" inside "Petersilienblatt") — the rule that would fix that is the
    // one that historically matched "Salz" to "Salzstangen". Widening retrieval is safe HERE and
    // only here: these records can never be accepted deterministically, only offered to a judge
    // that is also free to answer NONE.
    // A candidate scoring at or below the "has calories, shares no name" floor carries no identity
    // evidence at all, and offering it is asking the model to pick out of noise — measured over the
    // three validated recipes, that is what put salmon-in-oil in front of "Öl", cream liqueur in
    // front of "Kochsahne" and peas in front of "grüne Chilischoten". Recall candidates are exempt:
    // they earned their place by containing the query's core outright.
    const byCode = new Map<string, ScoredRecord>()
    for (const [code, c] of survivors) {
      if (c.score >= RERANK_MIN_CANDIDATE_SCORE) byCode.set(code, c)
    }
    for (const c of recallCandidates(query, data, attrs)) {
      if (!byCode.has(c.record.blsCode)) byCode.set(c.record.blsCode, c)
    }

    const reason = rerankTrigger(deterministic, byCode, attrs, query.state)
    if (!reason) return null

    const offered = [...byCode.values()]
      // Best deterministic score first, then the least-qualified name — a short BLS name is a
      // reliable proxy for "the plain version of this food".
      .sort((a, b) => b.score - a.score || a.record.nameDe.length - b.record.nameDe.length)
      .slice(0, config.llm.rerankMaxCandidates)
    if (offered.length === 0) return null

    const decision = await rerankCandidates(
      {
        provider: this.name,
        structuredName: query.structuredName ?? query.foodName,
        canonicalGerman: query.canonicalGerman ?? null,
        canonicalEnglish: query.foodName,
        coreFood: query.coreFoodGerman ?? null,
        state: query.state,
        attributes: attrs,
      },
      offered.map((c) => ({
        providerId: c.record.blsCode,
        productName: c.record.nameDe,
        kcalPer100g: c.record.nutrients.kcalPer100g,
        form: c.record.attributes.form,
        preservation: c.record.attributes.preservation,
        score: c.score,
        unmet: unmetModifierFamilies(identityText, c.record.nameDe),
      })),
    )

    if (!decision || decision.providerId === null) {
      logger.info(
        { foodName: query.foodName, trigger: reason, verdict: decision ? "none" : "unavailable" },
        "BLS: rerank did not select a candidate, deterministic outcome stands",
      )
      return null
    }

    const selected = offered.find((c) => c.record.blsCode === decision.providerId)
    if (!selected) return null // parse already range-checks; belt and braces
    if (deterministic && selected.record.blsCode === deterministic.record.blsCode) return null

    // The model may not trade one equally-unsupported subtype for another. Found live: it moved
    // "Senf" from "Senf mittelscharf" to "Senf scharf" — identical nutrition, identical stripped
    // identity — on the reasoning "same food type, no additional attributes". That is not
    // reranking, it is noise, and the deterministic order already settled it.
    if (deterministic && identityKey(selected.record.identityTokens) === identityKey(deterministic.record.identityTokens)) {
      logger.info(
        { foodName: query.foodName, kept: deterministic.record.nameDe, proposed: selected.record.nameDe },
        "BLS: rerank proposed a same-identity variant, keeping the deterministic winner",
      )
      return null
    }

    logger.info(
      {
        foodName: query.foodName, trigger: reason, selected: selected.record.nameDe,
        was: deterministic?.record.nameDe ?? null, confidence: decision.confidence, reason: decision.reason,
      },
      "BLS: rerank selected a different database record",
    )
    return { picked: selected, reason: decision.reason, confidence: decision.confidence }
  }
}

/**
 * Test/diagnostic seam: returns the ranked candidate list for one query text, so a regression can
 * assert WHY a record won rather than only that it did. Mirrors the provider's own scoring path.
 */
export async function __scoreForDiagnostics(
  queryText: string, category: string | null, foodType: FoodType, core: string | null, attrs = UNKNOWN_ATTRIBUTES,
): Promise<{ code: string; name: string; score: number; reason: string | null }[]> {
  const data = await getBlsData()
  if (!data) return []
  return scoreCandidates(queryText, data.records, category, foodType, core, attrs)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6)
    .map((s) => ({ code: s.record.blsCode, name: s.record.nameDe, score: Math.round(s.score), reason: s.mismatchReason }))
}

/**
 * Loads one BLS record by its official code, for a user-confirmed override's target. Reads the
 * same in-memory data every lookup uses, so an override can never drift from the live database.
 */
export async function loadBlsRecordByCode(code: string): Promise<{ name: string; nutrients: NutrientSet; state: FoodState; foodType: FoodType } | null> {
  const data = await getBlsData()
  const record = data?.byCode.get(code)
  if (!record) return null
  return { name: record.nameDe, nutrients: record.nutrients, state: record.inferredState, foodType: record.foodType }
}

export function createBlsProviderIfAvailable(): BlsProvider {
  return new BlsProvider()
}
