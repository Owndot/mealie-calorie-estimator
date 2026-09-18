import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { logger } from "../../utils/logger.js"
import { normalizeIdentityText } from "../../utils/text-normalize.js"
import { GERMAN_DESCRIPTOR_WORDS, germanTokenMatches } from "../providers/food-semantics.js"
import type { VocabularyEntry, VocabularyFile, VocabularyKind, VocabularyMatch } from "./types.js"

/**
 * A sparse, curated map from what people write in recipes to what the databases call it.
 *
 * It is NOT an attempt to enumerate food, and NOT a provider. It sits between normalization and
 * the resolver and supplies the one thing deterministic mode cannot derive for itself: a canonical
 * identity. Everything it does not know falls through to the existing resolver untouched.
 *
 * Sized by measurement, not ambition. The 84 entries here are exactly the terms that a 22-recipe
 * corpus showed resolving wrongly, unsafely, or not at all, each with a target verified against the
 * bundled databases. An independent 117-recipe corpus matched only 10% of its ingredient
 * occurrences against these aliases — so this is a mechanism to extend one measured failure at a
 * time, not a vocabulary project.
 *
 * Exact normalized matching only. No fuzzy distance: a misspelling that matters becomes its own
 * row ("Kodneybohnen"), which is reviewable in a way an edit-distance threshold is not.
 */

const LANGUAGES = ["de", "en"] as const
const VALID_KINDS: ReadonlySet<string> = new Set<VocabularyKind>([
  "synonym", "recipe_default", "exact_phrase", "ambiguous", "spelling_variant",
])
const VALID_PROVIDERS: ReadonlySet<string> = new Set(["bls", "usda-local"])

function resourceDir(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../resources/recipe-vocabulary")
}

/**
 * Rejects a row rather than letting it reach a resolution. A vocabulary entry is a standing claim
 * about a food, so a malformed one is worse than a missing one — the whole value of the layer is
 * that a human reviewed it.
 */
function validate(entry: unknown, language: string, seen: Set<string>): { ok: true; entry: VocabularyEntry } | { ok: false; reason: string } {
  if (typeof entry !== "object" || entry === null) return { ok: false, reason: "not an object" }
  const e = entry as Record<string, unknown>
  const alias = e.alias
  if (typeof alias !== "string" || !alias.trim()) return { ok: false, reason: "missing alias" }
  if (e.language !== language) return { ok: false, reason: `language "${String(e.language)}" does not match the file` }
  if (typeof e.kind !== "string" || !VALID_KINDS.has(e.kind)) return { ok: false, reason: `invalid kind "${String(e.kind)}"` }

  // The stored key must be what the lookup will actually compute, or the row is unreachable.
  const expected = normalizeIdentityText(alias)
  if (e.normalizedAlias !== expected) {
    return { ok: false, reason: `normalizedAlias "${String(e.normalizedAlias)}" != normalizeIdentityText("${alias}") = "${expected}"` }
  }
  if (!expected) return { ok: false, reason: "alias normalizes to nothing" }
  if (seen.has(expected)) return { ok: false, reason: `duplicate normalized alias "${expected}"` }

  const kind = e.kind as VocabularyKind
  if (kind === "ambiguous") {
    // An ambiguity marker that also names an identity or a record contradicts itself.
    if (e.identity || e.preferred || e.attributes) return { ok: false, reason: "an ambiguous entry must not carry identity, attributes or a preferred target" }
  } else if (typeof e.identity !== "string" || !e.identity.trim()) {
    return { ok: false, reason: `kind "${kind}" requires an identity` }
  }

  if (e.preferred !== undefined) {
    const p = e.preferred as Record<string, unknown>
    if (typeof p !== "object" || p === null) return { ok: false, reason: "preferred is not an object" }
    if (typeof p.provider !== "string" || !VALID_PROVIDERS.has(p.provider)) return { ok: false, reason: `preferred.provider "${String(p.provider)}" is not a database provider` }
    if (typeof p.id !== "string" || !p.id.trim()) return { ok: false, reason: "preferred.id missing" }
  }
  if (e.attributes !== undefined) {
    if (typeof e.attributes !== "object" || e.attributes === null || Array.isArray(e.attributes)) {
      return { ok: false, reason: "attributes must be an object" }
    }
    for (const [key, value] of Object.entries(e.attributes)) {
      const valid = key === "state" ? ["raw", "cooked", "dried", "unknown"].includes(String(value))
        : key === "form" ? ["whole", "ground", "powder", "leaf", "seed", "flakes", "paste", "unknown"].includes(String(value))
        : key === "preservation" ? ["fresh", "dried", "canned", "frozen", "unknown"].includes(String(value))
        : key === "fatPercent" ? value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100)
        : false
      if (!valid || (key !== "fatPercent" && typeof value !== "string")) {
        return { ok: false, reason: `unsupported attribute "${key}" or value` }
      }
    }
  }
  if (e.confidence !== undefined && (typeof e.confidence !== "number" || e.confidence < 0 || e.confidence > 1)) {
    return { ok: false, reason: "confidence must be between 0 and 1" }
  }
  return { ok: true, entry: e as unknown as VocabularyEntry }
}

let index: Map<string, VocabularyEntry> | null = null

/** Key is `${language}:${normalizedAlias}` — one flat map, so a lookup is a single hash probe. */
function keyOf(language: string, normalized: string): string {
  return `${language}:${normalized}`
}

export function loadVocabularyDirectory(dir: string): Map<string, VocabularyEntry> {
  const map = new Map<string, VocabularyEntry>()
  const aliases = new Map<string, string>()
  const collisions = new Set<string>()
  for (const language of LANGUAGES) {
    const file = path.join(dir, `${language}.json`)
    if (!fs.existsSync(file)) {
      logger.warn({ file }, "Recipe vocabulary: file missing, continuing without it")
      continue
    }
    let parsed: VocabularyFile
    try {
      parsed = JSON.parse(fs.readFileSync(file, "utf8")) as VocabularyFile
    } catch (err) {
      // A broken resource must not take the engine down; the resolver works without it.
      logger.error({ err, file }, "Recipe vocabulary: unreadable, continuing without it")
      continue
    }
    const seen = new Set<string>()
    let rejected = 0
    for (const raw of parsed.entries ?? []) {
      const result = validate(raw, language, seen)
      if (!result.ok) {
        rejected++
        logger.error({ file, alias: (raw as { alias?: unknown })?.alias, reason: result.reason }, "Recipe vocabulary: rejected entry")
        continue
      }
      const normalized = result.entry.normalizedAlias
      const previous = aliases.get(normalized)
      if (collisions.has(normalized) || (previous !== undefined && previous !== language)) {
        if (previous) map.delete(keyOf(previous, normalized))
        collisions.add(normalized)
        rejected++
        logger.error({ file, alias: normalized }, "Recipe vocabulary: cross-language collision; all copies rejected")
        continue
      }
      aliases.set(normalized, language)
      seen.add(result.entry.normalizedAlias)
      map.set(keyOf(language, result.entry.normalizedAlias), result.entry)
    }
    logger.info({ language, loaded: seen.size, rejected }, "Recipe vocabulary loaded")
  }
  return map
}

/** Loaded once. Exact lookup is a single map probe; nothing reads disk per ingredient. */
function getIndex(): Map<string, VocabularyEntry> {
  if (!index) index = loadVocabularyDirectory(resourceDir())
  return index
}

/** Test seam: forget the loaded resource so a fixture can be installed. */
export function __resetVocabularyForTests(replacement?: Map<string, VocabularyEntry> | null): void {
  index = replacement ?? null
}

export function vocabularyEntryCount(): number {
  return getIndex().size
}

/**
 * The entry for an ingredient's own words, or null.
 *
 * Cross-language duplicates are removed by the loader, including identical rows. No language
 * detection or file-order arbitration is attempted.
 */
export function lookupVocabulary(text: string | null | undefined): VocabularyMatch | null {
  if (!text) return null
  const normalized = normalizeIdentityText(text)
  if (!normalized) return null
  const idx = getIndex()
  for (const language of LANGUAGES) {
    const entry = idx.get(keyOf(language, normalized))
    if (!entry) continue
    return {
      alias: entry.alias,
      normalizedAlias: entry.normalizedAlias,
      language: entry.language,
      kind: entry.kind,
      identity: entry.identity ?? null,
      attributes: entry.attributes ?? {},
      preferred: entry.preferred ?? null,
      confidence: entry.confidence ?? null,
    }
  }
  return null
}

/**
 * Whether a candidate record NARROWS an ingredient the vocabulary marked ambiguous.
 *
 * "Bohnen" spans 28-344 kcal/100 g across green, kidney, black and dried beans. The resolver has
 * no basis to choose, and the highest-scoring record is not evidence — it is whichever variety
 * happens to sort first. So an ambiguous alias refuses any record that introduces identity the
 * ingredient never mentioned.
 *
 * It does NOT refuse a genuinely generic record: a name whose substantive words the query already
 * accounts for is the honest answer to a vague question and is allowed through. Descriptors
 * ("roh", "gekocht", "Konserve") never count as introduced identity — those axes are governed by
 * the attribute gates, not by this one.
 */
export function narrowsAmbiguousIngredient(queryText: string, candidateName: string): boolean {
  // Raw tokens, compared with germanTokenMatches(): germanStem() is asymmetric near its floor
  // ("bohnen" -> "bohn" but "bohne" stays "bohne"), so stemming both sides made a plain "Bohne"
  // look like a narrowing of "Bohnen".
  const queryTokens = normalizeIdentityText(queryText).split(/\s+/).filter(Boolean)
  for (const raw of normalizeIdentityText(candidateName).split(/\s+/)) {
    if (raw.length < MIN_IDENTITY_TOKEN_LENGTH || /^\d/.test(raw)) continue
    // Only preparation/preservation descriptors are exempt. A COLOUR is not exempt here, unlike
    // in recall: "Bohne grün" against an ambiguous "Bohnen" is precisely the narrowing this
    // refuses, and green vs kidney beans differ by an order of magnitude.
    if (GERMAN_DESCRIPTOR_WORDS.has(raw)) continue
    // Accounted for only when the query names this word, allowing for inflection. Containment is
    // checked in ONE direction: a query token may contain the candidate's ("Kidneybohnen" accounts
    // for "Bohne"), but the reverse is the narrowing itself — "Kidneybohne" against "Bohnen" adds
    // the variety, and treating that as accounted would defeat the whole gate.
    let accounted = false
    for (const q of queryTokens) {
      if (q === raw || germanTokenMatches(q, raw) || q.includes(raw)) { accounted = true; break }
    }
    if (!accounted) return true
  }
  return false
}

/** Below this a candidate token is too short to be read as introduced identity. */
const MIN_IDENTITY_TOKEN_LENGTH = 3
