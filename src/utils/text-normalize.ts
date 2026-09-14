/**
 * Deterministic German-aware text normalization, shared by every place matching/cache identity
 * depends on normalized text: ranking.ts's tokenize() (candidate similarity scoring and the
 * core-identity checks built on it), bls-provider.ts's tokenizeBls() (BLS's own hyphen-preserving
 * fuzzy scoring), and cache.ts's normalizeKey() (provider_match_cache identity, and BLS's
 * exact-match dictionary keys). scripts/import_bls.py's normalize_name() must be kept in sync
 * with normalizeIdentityText() by hand — Python can't import this module.
 *
 * Transliterates umlauts/ß to their standard ASCII digraphs BEFORE any other processing, rather
 * than relying on Unicode NFKD normalization (the previous approach here and in import_bls.py).
 * NFKD decomposes "ö" into "o" + a combining diaeresis (U+0308), and that combining mark then
 * gets silently stripped as a non-letter/number character by whatever char-class filtering runs
 * next — corrupting "Gewürz" into two unrelated garbage fragments ["gewu", "rz"] instead of one
 * coherent token, "Käse" into ["ka", "se"], "Öl" into ["o", "l"]. Found live while investigating a
 * run of Öl/Gewürz/Käse-adjacent false-mismatch and false-match bugs — this silently degraded
 * nameSimilarity scoring for essentially every German word containing an umlaut, and (separately)
 * had already broken BLS's own exact-match dictionary lookup for the same class of words, since
 * cache.ts's normalizeKey() and import_bls.py's normalize_name() diverged on exactly these words
 * (the JS side did no NFKD at all; the Python side did, with the same corruption).
 *
 * Never produces the lossy ä->a / ö->o / ü->u collapse either — only the standard ae/oe/ue/ss
 * digraphs, so "Öl" and a hypothetical "Ol" never collide.
 */
export function normalizeGermanText(s: string): string {
  if (typeof s !== "string") return ""
  return s
    .toLowerCase()
    .replace(/ß/g, "ss")
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
}

/**
 * Full normalized-identity form: normalizeGermanText() plus every non-letter/number character
 * collapsed to a single space and trimmed. This is the exact-match/cache-key form — Python's
 * normalize_name (scripts/import_bls.py) mirrors this precisely, so a query-time lookup and a
 * value precomputed at BLS-import time always agree.
 */
export function normalizeIdentityText(s: string): string {
  if (typeof s !== "string") return ""
  return normalizeGermanText(s)
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
}
