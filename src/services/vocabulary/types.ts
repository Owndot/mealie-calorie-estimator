import type { FoodAttributes, FoodState } from "../../types.js"

/**
 * What a vocabulary row asserts about an alias. The kinds are not decoration: they record HOW
 * confident the mapping is, so provenance can later distinguish a fact the cook stated from a
 * default the project chose on their behalf.
 */
export type VocabularyKind =
  /** The same food under another name. A fact. "Tahini" is "Tahin". */
  | "synonym"
  /** The usual kitchen reading, not something the ingredient said. "Mehl" is normally wheat flour. */
  | "recipe_default"
  /** A whole phrase whose meaning includes attributes: "Cooked Puy Lentils" is lentils, cooked. */
  | "exact_phrase"
  /** No safe default exists; the resolver must not be allowed to narrow. "Bohnen". */
  | "ambiguous"
  /** A misspelling of another alias. "Kodneybohnen". */
  | "spelling_variant"

/** A record this alias should prefer. Stored by id and re-loaded live — never copied nutrients. */
export interface VocabularyPreferredTarget {
  provider: "bls" | "usda-local"
  id: string
}

export type VocabularyAttributes = Partial<FoodAttributes> & { state?: FoodState }

export interface VocabularyProvenance {
  /** Presence means an alias matched, regardless of whether it influenced resolution. */
  alias: string
  kind: VocabularyKind
  /** Vocabulary enriched a resolution query (or enforced ambiguity), excluding priority sources. */
  semanticsApplied: boolean
  /** The resolver actually selected the reviewed target. */
  preferredSelected: boolean
}

export interface VocabularyEntry {
  /** As a human writes it, for review and logs. */
  alias: string
  /** normalizeIdentityText(alias) — the lookup key. Exact match only in v1. */
  normalizedAlias: string
  language: "de" | "en"
  kind: VocabularyKind
  /** The canonical food noun handed to the resolver as its core identity. Absent when ambiguous. */
  identity?: string
  /** Only attributes the alias itself states. Merged, never overriding what the ingredient said. */
  attributes?: VocabularyAttributes
  preferred?: VocabularyPreferredTarget
  confidence?: number
  provenance?: { source?: string; method?: string; reviewedAt?: string }
}

export interface VocabularyFile {
  version: number
  language: "de" | "en"
  entries: VocabularyEntry[]
}

/** What a lookup tells the caller, carried into provenance. */
export interface VocabularyMatch {
  alias: string
  normalizedAlias: string
  language: "de" | "en"
  kind: VocabularyKind
  identity: string | null
  attributes: VocabularyAttributes
  preferred: VocabularyPreferredTarget | null
  confidence: number | null
}
