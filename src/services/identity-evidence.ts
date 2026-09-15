import type { IngredientClassification } from "../types.js"

/**
 * What we actually KNOW about an ingredient's identity, as independent capabilities rather than a
 * single tier.
 *
 * A tiered enum was considered and rejected: the dimensions are genuinely composable — an
 * ingredient can carry verified brand evidence AND validated German/English/core identity, or
 * German identity with no English at all — and collapsing that into one ordered mode loses exactly
 * the information routing needs. Each flag answers one question: "may a provider that matches on
 * THIS kind of text be trusted here?"
 *
 * Found live: when whole-recipe classification degraded, every gate in ranking.ts short-circuited
 * permissively (unknown foodType, null core, null category all mean "no conflict"), so losing the
 * classification made matching LESS strict rather than more. These capabilities exist to invert
 * that: absent evidence must narrow what a provider may accept, never widen it.
 */
export interface IdentityEvidence {
  /**
   * A trustworthy GERMAN food identity exists. Effectively always true — the structured Mealie
   * food.name is German in this deployment and is always present — but stated explicitly so the
   * routing rule reads as a capability rather than an assumption.
   */
  german: boolean
  /**
   * A trustworthy ENGLISH food identity exists, i.e. canonicalEnglish is a real LLM translation
   * rather than a copy of the raw German name. Never inferred from the raw structured name: a
   * German word is not English identity just because no translation was available.
   */
  english: boolean
  /** A validated core/semantic identity noun exists (coreFoodGerman/coreFoodEnglish). */
  core: boolean
  /** A brand was found AND verified against the structured food name (never model world-knowledge). */
  brand: boolean
}

export function evidenceFor(c: Pick<IngredientClassification, "llmClassified" | "canonicalGerman" | "coreFoodGerman" | "coreFoodEnglish" | "brand">, structuredName: string): IdentityEvidence {
  const validated = c.llmClassified === true
  return {
    german: (structuredName?.trim().length ?? 0) > 0 || (c.canonicalGerman?.trim().length ?? 0) > 0,
    english: validated,
    core: validated && ((c.coreFoodGerman?.trim().length ?? 0) > 0 || (c.coreFoodEnglish?.trim().length ?? 0) > 0),
    brand: (c.brand?.trim().length ?? 0) > 0,
  }
}

/** Permissive default for callers with no classification context (tests, direct provider use). */
export const FULL_EVIDENCE: IdentityEvidence = { german: true, english: true, core: true, brand: true }

/**
 * Only the dimensions that actually change what a provider will ACCEPT belong in a cache identity.
 * `german` is excluded deliberately: it is constant in this deployment and would add a constant
 * segment to every key. The other three each gate a different provider/strictness decision, so a
 * miss recorded under one combination must never suppress a lookup under another.
 */
export function evidenceKey(e: IdentityEvidence): string {
  return `${e.english ? "E" : "-"}${e.core ? "C" : "-"}${e.brand ? "B" : "-"}`
}

/**
 * BLS runs its strict two-stage policy whenever the LLM-validated identity is missing. German text
 * is still trustworthy here — that is the whole point of stage 1 — but the semantic gates that
 * would normally police a fuzzy match are not available.
 */
export function usesDegradedBlsPolicy(e: IdentityEvidence): boolean {
  return !e.english || !e.core
}

/**
 * OFF indexes multilingual PRODUCT names, so a bare German word can collide with a branded product
 * in another language — observed live as "Minze" matching "Aproz Thé Grüntee-minze". It may
 * therefore only be queried with verified brand evidence, or a validated English identity to gate
 * against.
 */
export function mayQueryOff(e: IdentityEvidence): boolean {
  return e.brand || (e.english && e.core)
}

/**
 * USDA indexes ENGLISH descriptions. A validated English identity is the normal case; a degraded
 * ingredient may still be queried, but only in strict mode (see blsStrict/usdaStrict in the
 * providers), where the structured name has to survive the core-identity gate against English
 * candidate names. That gate is self-limiting: a German query word is absent from every correct
 * English candidate name, so a German-only ingredient fails closed without needing a language
 * detector, while a structured-English name like "olive oil" passes.
 */
export function mayQueryUsda(_e: IdentityEvidence): boolean {
  return true
}
