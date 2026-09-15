import type { FoodAttributes, FoodForm, FoodPreservation } from "../../types.js"
import { normalizeGermanText } from "../../utils/text-normalize.js"

/**
 * Language-aware food semantics shared by every provider.
 *
 * Found live: GENERIC_DESCRIPTOR_WORDS in ranking.ts was 52 English words and zero German ones,
 * while BLS's food names are entirely German. Every German qualifier in a BLS name ("roh",
 * "gekocht", "Konserve", "abgetropft", "mild", "gesäuert") was therefore scored as unexplained
 * FOREIGN FOOD CONTENT at -35 points, dropping otherwise-perfect candidates below
 * FUZZY_MIN_SCORE. Measured: core "Knoblauch" vs BLS "Knoblauch roh" scored 0.85*70 + 15 - 35 =
 * 39.5 against a threshold of 50. The perverse result was that supplying the CORRECT
 * coreFoodGerman made BLS fail on foods it matched fine without it.
 *
 * The fix is deliberately NOT "add every German modifier to the generic list". German qualifiers
 * split into two categories that must behave differently:
 *
 *   A. DESCRIPTIVE — explains an extra token without changing what the food is ("roh", "gekocht",
 *      "Konserve", "mild"). These belong in the generic vocabulary.
 *   B. IDENTITY-CHANGING — changes the food's nutrition materially ("halbfett", "fettarm",
 *      "mager", "light"). These must never be silently explained away: "Halbfettbutter" scored
 *      BETTER than "Butter mild gesäuert" for a plain "Butter" query precisely because the
 *      modifier was fused into one token and so counted as fully explained.
 */

/** Category A — descriptive/state words that legitimately explain an extra token. */
export const GERMAN_DESCRIPTOR_WORDS = new Set([
  // preparation
  "roh", "frisch", "gekocht", "gegart", "gebraten", "gebacken", "geduenstet", "gedaempft",
  "geschmort", "gegrillt", "frittiert", "geroestet", "pochiert", "blanchiert", "zubereitet",
  // preservation / handling
  "konserve", "abgetropft", "eingelegt", "tiefgefroren", "gefroren", "getrocknet", "haltbar",
  "pasteurisiert", "ultrahocherhitzt", "uht", "sterilisiert",
  // preparation of the piece
  "geschaelt", "ungeschaelt", "entkernt", "entsteint", "entbeint", "gewaschen", "geputzt",
  "gehackt", "geschnitten", "gewuerfelt", "gestueckelt", "halbiert",
  // quality / generic qualifiers
  "mild", "gesaeuert", "gesalzen", "ungesalzen", "gezuckert", "gesuesst", "ungesuesst",
  "natur", "klassisch", "ganz", "gross", "klein", "mittel", "reif", "unreif", "bio",
  // BLS structural words that describe the RECORD, not the food
  "mind", "durchschnitt", "mittelwert", "sorte", "sorten", "art", "allgemein", "sonstige",
  // BLS record qualifiers that describe the preparation of the same food, not a different one
  "poliert", "unpoliert", "parboiled", "geschliffen", "vorgegart", "instant", "loeslich",
  "ausgeloest", "ausgepresst", "gepresst", "verzehrfertig", "ungezuckert", "haushaltsueblich",
  "fett", "tr", "i", "gehalt", "anteil",
])

/**
 * Category B — modifiers that CHANGE the food's nutritional identity. Never generic; a candidate
 * carrying one of these must not satisfy a query that does not ask for it.
 *
 * `relative` marks modifiers expressed relative to the plain food (half-fat, low-fat) rather than
 * as an absolute percentage. Keyed by normalized German/English form.
 */
export const IDENTITY_MODIFIERS = new Set([
  // German
  "halbfett", "fettarm", "fettreduziert", "magerstufe", "mager", "vollfett", "vollmilch",
  "entrahmt", "teilentrahmt", "leicht", "light", "diaet", "zuckerfrei", "laktosefrei",
  "koffeinfrei", "alkoholfrei", "glutenfrei", "eifrei", "ersatz", "imitat", "analog",
  // English
  "lowfat", "low", "reduced", "skim", "skimmed", "nonfat", "fatfree", "lite", "diet",
  "substitute", "imitation", "alternative",
])

/**
 * A German compound whose PREFIX is an identity modifier ("Halbfett|butter", "Mager|quark").
 * German fuses modifiers onto the head noun, so a token-level check cannot see them — which is
 * exactly how "Halbfettbutter" passed as a plain "Butter".
 */
export function compoundIdentityModifier(token: string, headCore: string): string | null {
  if (!token.endsWith(headCore) || token === headCore) return null
  const prefix = token.slice(0, token.length - headCore.length)
  for (const mod of IDENTITY_MODIFIERS) {
    if (prefix === mod || prefix.startsWith(mod) || prefix.endsWith(mod)) return mod
  }
  return null
}

/**
 * Splits a fused German compound so it can match a database name that spells the same food as
 * separate words. Found live: the query "Hähnchenbrust" is one token while BLS spells it
 * "Hähnchen Brustfilet, roh" — no shared token, so name scoring was 0 and the core gate reported a
 * conflict, making an exact-quality record unreachable.
 *
 * Deliberately general and conservative: every split point is tried, both halves must be
 * substantial (>= 4 chars, the same floor the existing suffix rule uses against coincidental
 * endings), and a split only counts when BOTH halves are evidenced in the candidate. That last
 * condition is what stops it degenerating into arbitrary substring matching.
 */
export function compoundSegments(token: string, minPart = 4): [string, string][] {
  const out: [string, string][] = []
  for (let i = minPart; i <= token.length - minPart; i++) {
    out.push([token.slice(0, i), token.slice(i)])
  }
  return out
}

/**
 * True when a fused query token is explained by two candidate tokens, e.g.
 * "haehnchenbrust" -> "haehnchen" + "brust" against ["haehnchen","brustfilet","roh"].
 * A half matches a candidate token when the token starts with it (so "brust" reaches
 * "brustfilet"), which mirrors how German compounds attach qualifiers to the head.
 */
/** German glues compounds with linking morphemes: Rind+ER+hackfleisch, Hund+E+hütte. */
const LINKING_MORPHEMES = ["", "e", "en", "er", "es", "n", "s"]

/**
 * German plural/inflection tolerance — the counterpart of the English s/es rule. "Kidneybohnen"
 * and BLS's "Kidneybohne" are the same food; without this the canned-bean record was unreachable
 * and the query fell through to a less specific USDA entry. Conservative on purpose: only the
 * regular -n/-en/-e endings, and only on tokens long enough that stripping cannot collapse two
 * genuinely different short words.
 */
export function germanStem(token: string): string {
  if (token.length <= 5) return token
  for (const suffix of ["en", "n", "e"]) {
    if (token.endsWith(suffix) && token.length - suffix.length >= 4) return token.slice(0, -suffix.length)
  }
  return token
}

export function germanTokenMatches(a: string, b: string): boolean {
  return a === b || germanStem(a) === germanStem(b)
}

function halfMatches(half: string, candidateTokens: string[]): boolean {
  if (half.length < 3) return false
  return candidateTokens.some((t) => {
    // BOTH sides must be substantial. Without a floor on the candidate token, BLS's carcass-grade
    // code "(S X)" made a bare "x" prefix-match any query half, which scored an unrelated pork
    // record at 57 for a rice query — caught before this shipped.
    if (t.length < 3) return false
    return t === half || t.startsWith(half) || half.startsWith(t) || germanTokenMatches(t, half)
  })
}

export function compoundMatchesTokens(queryToken: string, candidateTokens: string[]): boolean {
  // Deliberately NO bare `t === queryToken` shortcut: a query token appearing verbatim among a
  // dish's other words is not compound evidence, it is the weak case the jaccard fallback already
  // handles. Short-circuiting here reintroduced "Koriander" matching "Rote-Linsensuppe mit
  // Koriander", which an existing regression test guards against.
  for (const [a, b] of compoundSegments(queryToken)) {
    if (!halfMatches(a, candidateTokens)) continue
    // Try the tail with each linking morpheme stripped, so "rind|erhackfleisch" also reaches
    // "hackfleisch" — otherwise the glue letters hide an otherwise perfect split.
    for (const link of LINKING_MORPHEMES) {
      if (!b.startsWith(link)) continue
      if (halfMatches(b.slice(link.length), candidateTokens)) return true
    }
  }
  return false
}

/**
 * Markers are matched as whole normalized tokens OR as German compound HEADS (token ends with the
 * marker) — "Korianderblätter" is one fused token, so a word-boundary regex could never see the
 * "blätter" inside it. Same rule the density resolver uses, for the same reason.
 *
 * "kraut" is deliberately absent from the leaf markers: in German it means both "herb" and
 * "cabbage" ("Sauerkraut"), so it is not reliable evidence of a leaf herb.
 */
const FORM_MARKERS: [FoodForm, string[]][] = [
  ["powder", ["pulver", "powder", "instant"]],
  ["ground", ["gemahlen", "gerieben", "geraspelt", "ground", "grated", "milled"]],
  ["flakes", ["flocken", "flakes", "schrot"]],
  ["leaf", ["blatt", "blaetter", "leaf", "leaves", "cilantro"]],
  ["seed", ["samen", "saat", "kerne", "kern", "seed", "seeds"]],
  ["paste", ["paste", "mark", "puree", "pueree", "mus"]],
]

const PRESERVATION_MARKERS: [FoodPreservation, string[]][] = [
  ["canned", ["konserve", "dose", "dosen", "canned", "tinned"]],
  ["frozen", ["tiefgefroren", "tiefkuehl", "gefroren", "frozen"]],
  ["dried", ["getrocknet", "gedoerrt", "dried", "dehydrated"]],
  ["fresh", ["frisch", "fresh", "roh", "raw"]],
]

function markerHit(tokens: string[], markers: string[]): boolean {
  return markers.some((m) => tokens.some((t) => t === m || (t.length > m.length && t.endsWith(m))))
}

/** Derives attributes from a food NAME (German or English). Used for candidates, and as a
 *  deterministic backstop for queries when the classifier supplied nothing. */
export function inferAttributesFromName(name: string): FoodAttributes {
  const tokens = normalizeGermanText(name).replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean)
  const form = FORM_MARKERS.find(([, m]) => markerHit(tokens, m))?.[0] ?? "unknown"
  const preservation = PRESERVATION_MARKERS.find(([, m]) => markerHit(tokens, m))?.[0] ?? "unknown"
  return { form, preservation, fatPercent: null }
}

/**
 * Forms that are mutually exclusive — asking for one must not accept the other. Whole/fresh root
 * ginger vs ground ginger, coriander leaf vs seed. Everything not listed stays permissive.
 */
const INCOMPATIBLE_FORMS: [FoodForm, FoodForm][] = [
  ["whole", "ground"], ["whole", "powder"], ["whole", "flakes"],
  ["leaf", "seed"], ["leaf", "ground"], ["leaf", "powder"],
  ["seed", "leaf"], ["paste", "powder"], ["paste", "ground"],
]

/**
 * Cross-axis rule: "fresh" is a preservation, "ground"/"powder" is a form, but a fresh root and a
 * ground dried spice are different foods with ~7x different energy density. Found live: "Ingwer
 * frisch" still reached USDA "Spices, ginger, ground" because neither single-axis gate fired —
 * the candidate name carries no preservation word at all.
 */
export function freshVsProcessedFormConflict(
  queryPreservation: FoodPreservation, candidateForm: FoodForm,
): boolean {
  if (queryPreservation !== "fresh") return false
  return candidateForm === "ground" || candidateForm === "powder" || candidateForm === "flakes"
}

export function formConflict(query: FoodForm, candidate: FoodForm): boolean {
  if (query === "unknown" || candidate === "unknown") return false
  if (query === candidate) return false
  return INCOMPATIBLE_FORMS.some(([a, b]) => (a === query && b === candidate) || (a === candidate && b === query))
}

/** Preservation classes whose nutrition differs materially per 100 g. */
const INCOMPATIBLE_PRESERVATION: [FoodPreservation, FoodPreservation][] = [
  ["fresh", "dried"], ["canned", "dried"], ["frozen", "dried"],
]

export function preservationConflict(query: FoodPreservation, candidate: FoodPreservation): boolean {
  if (query === "unknown" || candidate === "unknown") return false
  if (query === candidate) return false
  return INCOMPATIBLE_PRESERVATION.some(([a, b]) => (a === query && b === candidate) || (a === candidate && b === query))
}

/**
 * Fat-percentage compatibility for products that name one ("Kochsahne 15%").
 *
 * Compared against the candidate's MEASURED fat per 100 g rather than a number parsed out of its
 * name: German cheese names quote "Fett i. Tr." (fat in dry matter), a different scale that would
 * mis-compare by roughly a factor of two.
 *
 * Tolerance is max(2 pp, 15% relative) — tight enough that 15% cooking cream cannot become 30%
 * cream (and will honestly fall through when the database has only 10% and 20%), loose enough that
 * a "30 % Fett" record still satisfies a 30% request. Nutrients are never interpolated: there is no
 * sound general model for that, so an out-of-tolerance candidate is rejected rather than adjusted.
 */
export const FAT_EXACT_PP = 0.5

export function fatTolerance(requested: number): number {
  return Math.max(2, requested * 0.15)
}

export function fatConflict(requested: number | null, candidateFatPer100g: number | null): boolean {
  if (requested === null || candidateFatPer100g === null) return false
  return Math.abs(candidateFatPer100g - requested) > fatTolerance(requested)
}

/** True when the match is within tolerance but not effectively exact — recorded in provenance. */
export function fatApproximate(requested: number | null, candidateFatPer100g: number | null): boolean {
  if (requested === null || candidateFatPer100g === null) return false
  const delta = Math.abs(candidateFatPer100g - requested)
  return delta > FAT_EXACT_PP && delta <= fatTolerance(requested)
}

/** Compact, stable serialization for cache identity. */
export function attributesKey(a: FoodAttributes): string {
  return `${a.form}/${a.preservation}/${a.fatPercent ?? "-"}`
}
