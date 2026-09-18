import type { FoodAttributes, FoodForm, FoodPreservation, FoodState } from "../../types.js"
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
  // preservation / handling. "dose"/"dosen"/"glas" name the CONTAINER, exactly like BLS's own
  // "Konserve" — found live: "Kidneybohnen a. d. Dose" scored 23 against the perfect record
  // "Kidneybohne reif, Konserve, abgetropft" because "Dose" was counted as a second food.
  "konserve", "konserven", "dose", "dosen", "glas", "abgetropft", "eingelegt", "tiefgefroren",
  "gefroren", "getrocknet", "haltbar", "pasteurisiert", "ultrahocherhitzt", "uht", "sterilisiert",
  // preparation of the piece
  "geschaelt", "ungeschaelt", "entkernt", "entsteint", "entbeint", "gewaschen", "geputzt",
  "gehackt", "geschnitten", "gewuerfelt", "gestueckelt", "halbiert",
  // quality / generic qualifiers
  "mild", "gesaeuert", "gesalzen", "ungesalzen", "gezuckert", "gesuesst", "ungesuesst",
  "natur", "klassisch", "ganz", "gross", "klein", "mittel", "reif", "unreif", "bio",
  // ORGANOLEPTIC qualifiers — heat, texture and cut describe how the SAME food tastes or is cut,
  // not what it is. Found live: BLS's four mustards ("Senf mittelscharf/scharf/extra scharf",
  // all 111 kcal) each lost 35 points for their heat word and tied at 39.5 against a threshold of
  // 50, so the only mustard that could still be reached was the one whose modifier happened to be
  // whitelisted — "Senf süß" (177 kcal), the single nutritionally DIFFERENT record of the four.
  "scharf", "mittelscharf", "pikant", "wuerzig", "herzhaft", "kraeftig", "zart", "fein", "grob",
  // BLS structural words that describe the RECORD, not the food
  "mind", "durchschnitt", "mittelwert", "sorte", "sorten", "art", "allgemein", "sonstige",
  // BLS record qualifiers that describe the preparation of the same food, not a different one
  "poliert", "unpoliert", "parboiled", "geschliffen", "vorgegart", "instant", "loeslich",
  "ausgeloest", "ausgepresst", "gepresst", "verzehrfertig", "ungezuckert", "haushaltsueblich",
  "fett", "tr", "i", "gehalt", "anteil",
  // Compound PREFIXES BLS uses to mark an ordinary table/household grade of a food rather than a
  // different food: Speise|zwiebel, Speise|salz, Speise|quark, Tafel|wasser, Voll|milch,
  // Haushalts|zucker. Needed by compoundSpecifier(), which otherwise reads them as introduced
  // content. They are listed here rather than special-cased because that is exactly what they are:
  // category-A descriptors that happen to be fused rather than spelled as separate words.
  "speise", "speisen", "tafel", "haushalts", "voll", "standard", "normal",
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
 * Families of IDENTITY_MODIFIERS that answer for one another. "Light", "leicht", "fettarm" and
 * "mager" all state the same nutritional claim, so any of them satisfies a query asking for any
 * other; none of them is satisfied by a candidate that states nothing.
 */
const MODIFIER_FAMILIES: [string, string[]][] = [
  ["reduced-fat", ["halbfett", "fettarm", "fettreduziert", "magerstufe", "mager", "leicht", "light",
    "lite", "lowfat", "low", "reduced", "skim", "skimmed", "nonfat", "fatfree", "entrahmt",
    "teilentrahmt", "diaet", "diet", "leichte", "leichter"]],
  ["full-fat", ["vollfett", "sahne", "creme", "cream"]],
  ["substitute", ["ersatz", "imitat", "analog", "substitute", "imitation", "alternative", "vegan"]],
]

/**
 * Nutritional claims the query makes that the candidate does not.
 *
 * Found live twice: "Mayo Light" resolved to BLS's "Salatmayonnaise (Fertigprodukt)" and
 * "mageres Rinderhackfleisch" to "Rind Hackfleisch, roh" — in both cases the explicit modifier
 * simply evaporated, and the match was then reported as if it were equivalent. These are real
 * nutritional differences (a light mayonnaise is roughly half the energy of a full one), so the
 * shortfall is scored against the candidate, recorded in provenance and reflected in match quality
 * rather than silently dropped.
 *
 * Returns family names, not raw words, so "mager" is answered by "fettarm" and vice versa.
 */
export function unmetModifierFamilies(queryText: string, candidateName: string): string[] {
  const asked = semanticTokens(queryText)
  const offered = semanticTokens(candidateName)
  const unmet: string[] = []
  for (const [family, words] of MODIFIER_FAMILIES) {
    // A family is "asked for" only when the query names it as its own word or compound head —
    // never when it merely appears inside an unrelated token.
    if (!markerHit(asked, words)) continue
    if (markerHit(offered, words)) continue
    unmet.push(family)
  }
  return unmet
}

/**
 * Families a record's own NAME asserts — the positive half of unmetModifierFamilies().
 *
 * unmetModifierFamilies() answers "what did the query ask for that this record does not say?",
 * which is only meaningful for a record that HAS a name to read. This answers the narrower
 * question the resolver actually needs: what does this record claim about itself? A record with no
 * name claims nothing, and gets an empty list — which is the whole point. An empty unmet list and
 * an empty stated list look identical from the outside and mean opposite things, so the two are
 * kept as separate questions rather than inferred from one another.
 */
export function statedModifierFamilies(candidateName: string): string[] {
  const offered = semanticTokens(candidateName)
  return MODIFIER_FAMILIES.filter(([, words]) => markerHit(offered, words)).map(([family]) => family)
}

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

/** Minimum length for a compound prefix to be read as a word rather than a linking fragment. */
const MIN_SPECIFIER_LENGTH = 3

/**
 * The generalization of compoundIdentityModifier(): ANY substantial compound prefix that is not a
 * recognized descriptor narrows the candidate to a SUB-VARIETY of the query's core food.
 *
 * German is right-headed, so "Reis|nudeln" really is a kind of "Nudeln" — which is precisely the
 * problem. Found live across three of the reported failures:
 *
 *   query "Nudeln"    -> BLS "Reisnudeln roh"      (rice noodles: a different grain entirely)
 *   query "Teigwaren" -> BLS "Eierteigwaren roh"   (egg pasta: an added ingredient)
 *   query "Butter"    -> BLS "Halbfettbutter"      (the case the old closed list already caught)
 *
 * In each, the candidate token literally contains the query's core, so the old
 * `t.includes(core) -> fully explained` rule scored the narrower food as if it were the plain one.
 * The query never asked for rice, egg or half fat; a candidate must not introduce them.
 *
 * Returns the introduced specifier, or null when the token is just the core (possibly inflected,
 * or carrying a descriptor prefix like "Speise|zwiebel" / "Voll|milch").
 */
export function compoundSpecifier(token: string, core: string, descriptors: ReadonlySet<string>): string | null {
  if (germanTokenMatches(token, core)) return null

  // Match the core as the compound HEAD, tolerating inflection on EITHER side: the core may be the
  // plural ("Kidneybohnen" against core "Kidneybohne") or the candidate may be ("Back|erbsen"
  // against core "Erbse"). Missing the second direction let BLS's "Backerbsen" — deep-fried snack
  // peas at 469 kcal — pass as plain peas, since the token still merely *contained* the core.
  const heads = [core, germanStem(core), ...(core.length >= MIN_PLURAL_BASE ? PLURAL_ENDINGS.map((e) => core + e) : [])]
  const head = heads.find((h) => h.length >= MIN_SPECIFIER_LENGTH && token.endsWith(h) && token.length > h.length)
  // The core appears somewhere else in the token (as its prefix, or in the middle). German
  // identity lives in the head, so this is not sub-variety evidence — left permissive, as before.
  if (!head) return null

  const prefix = token.slice(0, token.length - head.length)
  // Both spellings count as the same word: a descriptor may carry the linking morpheme
  // ("Speise|zwiebel" -> "speise") or not ("Rind|er|hackfleisch" -> "rind"), and checking only the
  // stripped form silently turned "speise" into the unknown fragment "speis".
  const spellings = [prefix]
  for (const link of LINKING_MORPHEMES) {
    if (link && prefix.endsWith(link) && prefix.length - link.length >= MIN_SPECIFIER_LENGTH) {
      spellings.push(prefix.slice(0, prefix.length - link.length))
      break
    }
  }
  if (spellings.every((p) => p.length < MIN_SPECIFIER_LENGTH)) return null
  if (spellings.some((p) => descriptors.has(p) || GERMAN_DESCRIPTOR_WORDS.has(p) || absenceMarkerStem(p) !== null)) return null
  // The stripped spellings exist only to look the word up; the specifier itself is returned as it
  // actually appears, since stripping is a guess ("reis" is not "rei" with a linking -s).
  return prefix
}

/**
 * Macronutrient/energy components whose removal genuinely changes a food's nutrition. Used by
 * absenceMarkerStem() to keep "zuckerfrei"/"alkoholfrei" identity-changing while letting
 * "eifrei"/"glutenfrei"/"laktosefrei" behave as the descriptors they are.
 */
const ENERGY_BEARING_COMPONENTS = new Set(["fett", "zucker", "alkohol", "kohlenhydrat", "kohlenhydrate", "fat", "sugar", "alcohol", "carb", "carbs"])

/**
 * "Free-from" markers state the ABSENCE of an ingredient. They never add a foreign food, so for a
 * query that does not mention the excluded ingredient they are descriptive, not identity-changing
 * — found live: BLS's plain durum pasta is named "Teigwaren eifrei, roh" ("egg-FREE"), and the
 * -35 foreign-content penalty on "eifrei" was the only reason it lost to "Eierteigwaren roh", the
 * egg pasta that actually does add an ingredient.
 *
 * Returns the excluded stem so the caller can check whether the query asked for it ("Eiernudeln"
 * must still reject an egg-free record). Energy-bearing components are excluded outright: a
 * sugar-free or alcohol-free product IS nutritionally different regardless of the query.
 */
export function absenceMarkerStem(token: string): string | null {
  const suffix = ["frei", "free"].find((s) => token.length > s.length + 1 && token.endsWith(s))
  if (!suffix) return null
  const stem = token.slice(0, token.length - suffix.length).replace(/[-\s]+$/, "")
  if (stem.length < 2 || ENERGY_BEARING_COMPONENTS.has(stem)) return null
  return stem
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

/** Regular plural/inflection endings a German noun picks up: Erbse -> Erbsen, Tomate -> Tomaten. */
export const PLURAL_ENDINGS = ["n", "en", "e", "s"]

/**
 * Minimum length of the SHORTER form before a plural ending is allowed to join two words.
 *
 * germanStem() alone is asymmetric near its own floor — it stems "erbsen" to "erbs" but returns
 * "erbse" untouched, so the two never met and BLS's "Erbse reif" was unreachable from "Erbsen".
 * Comparing the shorter form against the longer plus an ending fixes that without loosening the
 * stemmer for everything else: at five characters "erbse"/"erbsen" join while the four-character
 * "reis"/"reise" (rice vs journey) deliberately still do not.
 */
const MIN_PLURAL_BASE = 5

export function germanTokenMatches(a: string, b: string): boolean {
  if (a === b || germanStem(a) === germanStem(b)) return true
  const [short, long] = a.length <= b.length ? [a, b] : [b, a]
  if (short.length < MIN_PLURAL_BASE) return false
  return PLURAL_ENDINGS.some((e) => long === short + e)
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
  // "rosenscharf" and "edelsuess" are grade names for ground paprika and appear on nothing else,
  // so they are spice evidence wherever they occur — the words themselves carry the form.
  ["powder", ["pulver", "powder", "instant", "rosenscharf", "edelsuess"]],
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

/**
 * German adjectives inflect for case and gender ("getrocknet" -> "getrocknete Tomate",
 * "getrockneter Thymian"), and the compound-head test is an endsWith, so the inflected form
 * matched nothing at all: "Getrocknete Tomate in Öl" came back with preservation "unknown" instead
 * of "dried". The weak-declension endings are tried explicitly rather than by running germanStem(),
 * which is a conservative PLURAL stemmer and does not know "-er"/"-es"/"-em".
 *
 * Returns the index of the earliest matching token, or -1. The position matters: a BLS name may
 * carry two preservation words ("Tomate getrocknet, in Öl, Konserve, abgetropft" is a DRIED tomato
 * that happens to be jarred), and BLS states the primary transformation first, so earliest-wins
 * reads the name the way it is written instead of the order the marker table happens to use.
 */
const ADJECTIVE_ENDINGS = ["", "e", "er", "es", "en", "em"]

function markerIndex(tokens: string[], markers: string[]): number {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    const hit = markers.some((m) =>
      ADJECTIVE_ENDINGS.some((e) => t === m + e) || (t.length > m.length && t.endsWith(m)))
    if (hit) return i
  }
  return -1
}

function markerHit(tokens: string[], markers: string[]): boolean {
  return markerIndex(tokens, markers) >= 0
}

export function semanticTokens(name: string): string[] {
  return normalizeGermanText(name).replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean)
}

/**
 * DERIVED-PRODUCT markers: words naming something MADE FROM a food rather than the food itself —
 * a seasoning blend, a brine, a juice, a stock, an extract, a powder, a paste.
 *
 * This is the mirror image of ranking.ts's categoryConflict(), which only ever fires when the
 * CANDIDATE looks like a manufactured product. The reported failures run the other way: the QUERY
 * named a derived product and the candidate was the raw whole food —
 *
 *   "Knoblauchgewürz" (garlic seasoning) -> USDA "Garlic, raw"    (143 kcal for a spice blend)
 *   "Gurkenwasser"    (pickle brine)     -> USDA "Cucumber, raw"
 *
 * Nothing rejected these because the unmatched query words ("gewürz", "wasser") cost nothing:
 * coreIdentityScoreAdjustment only ever penalized unexplained CANDIDATE content. Grouped into one
 * class deliberately — a garlic seasoning may legitimately resolve to a garlic POWDER record, both
 * being derived preparations, while neither may become the raw clove.
 */
const DERIVED_PRODUCT_CLASSES: [string, string[]][] = [
  ["seasoning", ["gewuerz", "gewuerze", "gewuerzmischung", "wuerzmischung", "wuerzer", "streuwuerze",
    "seasoning", "seasonings", "mischung", "blend", "rub"]],
  ["powder", ["pulver", "powder"]],
  ["paste", ["paste", "mark", "puree", "pueree", "mus"]],
  // Liquid DRAWN OFF a food — a pickling brine, a steeping liquor. Not the food, and not its juice.
  ["brine", ["wasser", "water", "lake", "sud", "aufguss", "brine"]],
  ["juice", ["saft", "juice", "nektar", "nectar"]],
  ["broth", ["bruehe", "broth", "stock", "fond"]],
  ["vinegar", ["essig", "vinegar"]],
  ["concentrate", ["extrakt", "extract", "konzentrat", "concentrate", "sirup", "syrup", "essenz", "essence"]],
]

const DERIVED_PRODUCT_MARKERS = DERIVED_PRODUCT_CLASSES.flatMap(([, m]) => m)

/**
 * Which derived-product classes may stand in for one another. Dry preparations of a spice are
 * interchangeable enough — a "garlic seasoning" is fairly answered by a garlic POWDER record — but
 * liquids are not: found live, the reranker accepted BLS's "Gemüsesaft aus Gurke" (cucumber JUICE)
 * for "Gurkenwasser" (pickle brine), reasoning that "both are derived from cucumbers". Sharing a
 * source ingredient is not being the same food product, and treating every derived marker as one
 * undifferentiated class is what let that through.
 */
const COMPATIBLE_DERIVED_CLASSES: [string, string][] = [
  ["seasoning", "powder"], ["seasoning", "paste"], ["powder", "paste"],
]

function derivedClasses(text: string): Set<string> {
  const tokens = semanticTokens(text)
  const found = new Set<string>()
  for (const [name, markers] of DERIVED_PRODUCT_CLASSES) if (markerHit(tokens, markers)) found.add(name)
  return found
}

function classesCompatible(a: string, b: string): boolean {
  if (a === b) return true
  return COMPATIBLE_DERIVED_CLASSES.some(([x, y]) => (x === a && y === b) || (x === b && y === a))
}

/** True when a name carries any derived-product marker — see DERIVED_PRODUCT_MARKERS. */
export function namesDerivedProduct(text: string): boolean {
  return markerHit(semanticTokens(text), DERIVED_PRODUCT_MARKERS)
}

/** True for a single token that names a derived product — used to credit it instead of penalizing it. */
export function isDerivedProductMarker(token: string): boolean {
  return markerHit([token], DERIVED_PRODUCT_MARKERS)
}

/**
 * True when the query names a derived product (per DERIVED_PRODUCT_MARKERS) that the candidate
 * does not.
 *
 * Self-limiting by the CANDIDATE side alone, deliberately not by the core: a bare
 * "Wasser"/"Gemüsebrühe"/"Tomatenmark" query — whose core IS the derived product — is satisfied
 * because its correct candidates ("Trinkwasser", "Gemüsebrühe", "Tomatenmark") all carry a marker
 * of their own. An earlier version also exempted a marker appearing in the CORE text, which turned
 * out to disable the gate exactly when the classifier had NOT stripped the modifier: with
 * coreFoodEnglish "garlic seasoning" instead of "garlic", "Garlic, raw" was accepted again. A rule
 * that stops working when the upstream classification is less precise is the wrong rule — absent
 * evidence must make a provider stricter, never more permissive.
 *
 * `coreText` is retained so callers need not change, and so this stays the obvious place to
 * reintroduce a core-based exemption should one ever prove genuinely necessary.
 */
export function derivedProductConflict(queryText: string, _coreText: string | null | undefined, candidateName: string): boolean {
  const asked = derivedClasses(queryText)
  if (asked.size === 0) return false
  const offered = derivedClasses(candidateName)
  if (offered.size === 0) return true
  // Every class the query named must be answerable by something the candidate names.
  return ![...asked].some((a) => [...offered].some((o) => classesCompatible(a, o)))
}

/**
 * PREPARATION words the ingredient text actually states, as separate tokens (German adjective
 * endings included). Exact-token matching only — deliberately NOT the compound-head rule the
 * marker tables use, because a compound head would read "Bratwurst" as fried and "Backpulver" as
 * baked. A preparation is claimed by a word, not by a syllable.
 */
const PREPARATION_MARKERS: [FoodState, string[]][] = [
  ["cooked", [
    "gekocht", "gegart", "vorgekocht", "vorgegart", "gebraten", "angebraten", "gebacken",
    "gegrillt", "gedaempft", "gedunstet", "geduenstet", "geschmort", "blanchiert", "pochiert",
    "geroestet", "frittiert",
    "cooked", "boiled", "precooked", "prepared", "baked", "fried", "roasted", "grilled",
    "steamed", "braised", "poached", "blanched", "sauteed",
  ]],
  ["raw", ["roh", "raw", "uncooked"]],
  ["dried", ["getrocknet", "gedoerrt", "gedorrt", "dried", "dehydrated"]],
]

/**
 * The preparation state the TEXT states, or "unknown" when it states none.
 *
 * This is the evidence half of the classification-stability rule. An unqualified "300 g Nudeln"
 * states no preparation at all, and the quantity therefore refers to the state the ingredient was
 * MEASURED in — the state it is bought and enters the recipe in — never the state a later
 * instruction turns it into. Measured in production: ten consecutive estimates of one unchanged
 * recipe returned "cooked" eight times and "raw" twice for that exact ingredient, moving the
 * recipe between 2004 and 2604 kcal, because nothing downstream checked the claim against the
 * words actually present.
 */
export function statedPreparation(text: string): FoodState {
  const tokens = semanticTokens(text)
  for (const [state, markers] of PREPARATION_MARKERS) {
    const hit = tokens.some((t) => markers.some((m) => ADJECTIVE_ENDINGS.some((e) => t === m + e)))
    if (hit) return state
  }
  return "unknown"
}

/**
 * States that are a TRANSFORMATION of the ingredient rather than the state it is bought in.
 * Claiming one without textual support invents a fact — and invents it inconsistently, which is
 * what made the same recipe oscillate by 600 kcal.
 */
const TRANSFORMED_STATES: ReadonlySet<FoodState> = new Set<FoodState>(["cooked", "dried"])

/**
 * Reconciles a classifier's `state` claim with what the ingredient text actually supports.
 *
 * Priority, exactly as specified:
 *   1. an explicit preparation in the text wins outright — "gekochter Reis" is cooked, "Bohnen
 *      aus der Dose" keeps its canned preservation, "getrocknete Tomaten" are dried;
 *   2. otherwise an untransformed claim ("raw") passes through, because the normal input state of
 *      an unqualified ingredient is the one it is purchased and measured in;
 *   3. a TRANSFORMED claim with no textual support is refused and degraded to "unknown", which is
 *      permissive downstream and reaches the dry/raw record for exactly the foods this matters
 *      for (pasta, rice, pulses) without needing to know anything about them.
 *
 * No food is named anywhere in this rule: it reads the ingredient's own words and the shape of
 * the claim, so it generalises to whatever the next unqualified ingredient happens to be.
 */
export function reconcileState(claimed: FoodState, text: string): FoodState {
  const stated = statedPreparation(text)
  if (stated !== "unknown") return stated
  return TRANSFORMED_STATES.has(claimed) ? "unknown" : claimed
}

/** Below this a prefix is too short to be reliable evidence of a source food by containment. */
const MIN_SOURCE_TOKEN_LENGTH = 4

/**
 * The SOURCE food a derived-product name is made from, with the derivative word itself removed.
 *
 * English spells it as a separate word ("cucumber water" -> "cucumber"); German fuses it into a
 * compound ("Gurkenwasser" -> "gurken"), so a compound whose head is the marker contributes its
 * prefix, minus the linking element. A name consisting only of the marker ("Wasser", "juice")
 * yields nothing at all, which is the correct answer: such a query IS the carrier.
 */
function sourceIdentityTokens(text: string, descriptorWords: ReadonlySet<string>): string[] {
  const out: string[] = []
  for (const token of semanticTokens(text)) {
    const marker = DERIVED_PRODUCT_MARKERS.find((m) =>
      ADJECTIVE_ENDINGS.some((e) => token === m + e) || (token.length > m.length && token.endsWith(m)))
    if (!marker) {
      out.push(token)
      continue
    }
    if (token.length > marker.length) {
      out.push(token.slice(0, token.length - marker.length).replace(/(en|s|n)$/, ""))
    }
  }
  return out.filter((t) =>
    t.length >= MIN_SOURCE_TOKEN_LENGTH && !/^\d/.test(t) && !descriptorWords.has(t))
}

/**
 * CARRIER gate: a product derived FROM something must name that something.
 *
 * derivedProductConflict() checks the query's derivative CLASS against the candidate's, and it is
 * satisfied as soon as both sides are the same class. That leaves the source unchecked, and the
 * source is the whole identity. Measured in production: "Gurkenwasser" (pickle brine) classified
 * as canonicalEnglish "cucumber water" with core "cucumber water" resolved to USDA's "Water,
 * bottled, generic" at confidence 0.7 — both sides are the brine class, the core gate was
 * satisfied by the shared word "water", and nothing anywhere asked where the cucumber went. The
 * ingredient became 0 kcal plain water.
 *
 * So: when the query names a derived product AND names a source, a candidate that names none of
 * that source is the carrier, not the food. Deliberately independent of coreFoodEnglish — the
 * production failure happened because the classifier folded the marker INTO the core, and a rule
 * that stops working when the upstream classification is less precise is the wrong rule.
 *
 * Generalises past the case that found it: "Apfelsaft"/"apple juice", "Vanilleextrakt"/"vanilla
 * extract", "Hühnerbrühe"/"chicken broth" are all refused a record that names only the liquid.
 * Queries whose source IS the derivative ("Wasser", "Essig", "Brühe") never trigger it.
 */
export function carrierConflict(
  queryText: string,
  candidateName: string,
  descriptorWords: ReadonlySet<string>,
): boolean {
  if (!namesDerivedProduct(queryText)) return false
  const source = sourceIdentityTokens(queryText, descriptorWords)
  if (source.length === 0) return false
  const candidateTokens = semanticTokens(candidateName)
    .filter((t) => t.length >= MIN_SOURCE_TOKEN_LENGTH)
  return !source.some((s) => candidateTokens.some((t) => t.includes(s) || s.includes(t)))
}

/**
 * Plant-part words, as SEPARATE tokens only. A fused compound ("Sesam|samen",
 * "Sonnenblumen|kerne") names the food itself; a standalone part word narrows a food to one of its
 * parts ("Spices, coriander SEED" vs "Coriander (cilantro) LEAVES, raw" — 298 vs 23 kcal/100 g).
 */
export type PlantPart = "seed" | "leaf" | "root"

const PLANT_PART_TOKENS: [PlantPart, string[]][] = [
  ["seed", ["samen", "saat", "kerne", "kern", "seed", "seeds"]],
  ["leaf", ["blatt", "blaetter", "leaf", "leaves", "kraut", "cilantro", "greens"]],
  ["root", ["wurzel", "wurzeln", "root", "roots", "knolle"]],
]

/** The plant part a candidate name names as a separate word, or null. */
export function standalonePlantPart(name: string): PlantPart | null {
  const tokens = semanticTokens(name)
  return PLANT_PART_TOKENS.find(([, words]) => words.some((w) => tokens.includes(w)))?.[0] ?? null
}

/** Derives attributes from a food NAME (German or English). Used for candidates, and as a
 *  deterministic backstop for queries when the classifier supplied nothing. */
function earliestMarker<T>(tokens: string[], table: [T, string[]][]): T | null {
  let best: T | null = null
  let bestAt = Infinity
  for (const [value, markers] of table) {
    const at = markerIndex(tokens, markers)
    if (at >= 0 && at < bestAt) { bestAt = at; best = value }
  }
  return best
}

/**
 * USDA states the spice category in the description itself: all 42 of its spice records begin
 * "Spices, ". That prefix is preparation evidence the marker tables cannot see, because most of
 * those names carry no preparation WORD at all — "Spices, paprika" and "Spices, cardamom" read as
 * attribute-free, so nothing distinguished a dried ground spice at ~300 kcal/100 g from the fresh
 * vegetable of the same name at ~25.
 *
 * Measured on v1.1.0: deterministic "rote Paprika" and "grüne Paprika" both resolved to USDA
 * "Spices, paprika" (282 kcal/100 g) rather than "Peppers, sweet, red/green, raw" (20-26), a ~10x
 * error on an ingredient used in vegetable quantities. Both candidates looked equally silent.
 *
 * A spice is dried by definition, so the category states a preservation. Recording it lets the
 * rules already in place do the work: attributeFit() prefers a record that introduces nothing over
 * one that introduces an attribute the ingredient never mentioned, and preservationConflict()
 * rejects a dried record outright for an explicitly fresh query. A name carrying its own, more
 * specific marker keeps it — "Spices, cumin seed" stays seed, "Spices, coriander leaf, dried"
 * stays leaf/dried — because this only fills a gap, it never overrides evidence.
 */
const USDA_SPICE_CATEGORY = /^\s*spices\s*,/i

/**
 * German food words that name a FRESH VEGETABLE while the identical English word names a dried
 * spice. Deliberately not a translation table: it exists because the nutrient databases disagree
 * about what the same letters mean, and the disagreement is worth ~10x in energy density.
 *
 * "Paprika" is the case this was built for. German "Paprika" is the bell pepper, ~20-38 kcal/100 g;
 * English "paprika" is the ground dried spice, 282. USDA holds exactly one record containing the
 * token — "Spices, paprika" — and files the vegetable under "Peppers, sweet, red, raw", which
 * shares no token with the German phrase at all. So no ranking, attribute or rerank rule can reach
 * the right record from a German query: the only safe deterministic answer is to refuse the wrong
 * one. Measured on v1.1.0, "rote Paprika" and "grüne Paprika" both resolved to the 282 kcal spice.
 *
 * Kept to the words where the collision is real and the energy gap is large. A term only belongs
 * here if the German sense is a fresh vegetable, the English sense is a dried spice, and both
 * senses are spelled the same.
 */
const GERMAN_VEGETABLE_ENGLISH_SPICE = ["paprika"]

/**
 * Whether the text names one of those false friends in its VEGETABLE sense — that is, with no word
 * anywhere in it claiming a spice preparation. "Paprikapulver", "Paprika rosenscharf" and
 * "Paprika edelsüß" all state a powder and are excluded; "rote Paprika" and "Paprikaschote" do not
 * and are included, as is the bare word.
 *
 * Reported as preservation "fresh" rather than as a new axis, because that is what it means and
 * because the rules that must act on it already exist: preservationConflict() rejects a dried
 * candidate for a fresh query, and freshVsProcessedFormConflict() rejects a ground or powdered one.
 */
/**
 * Smoking is a spice preparation here, but it is NOT a form and must not become one: "geräuchert"
 * is also how a salmon, a ham and a sausage are described, and those are whole foods. It is read
 * only as a reason the false-friend rule does not apply — "smoked paprika" is unambiguously the
 * spice, while a smoked fish is unaffected because no false friend is named.
 */
const SMOKED_MARKERS = ["geraeuchert", "smoked"]

function namesFreshVegetableFalseFriend(tokens: string[]): boolean {
  if (!tokens.some((t) => GERMAN_VEGETABLE_ENGLISH_SPICE.some((w) => t === w || t.startsWith(w)))) return false
  if (earliestMarker(tokens, FORM_MARKERS) !== null) return false
  return markerIndex(tokens, SMOKED_MARKERS) < 0
}

export function inferAttributesFromName(name: string): FoodAttributes {
  const tokens = semanticTokens(name)
  const stated = earliestMarker(tokens, PRESERVATION_MARKERS)
  const preservation = stated
    ?? (USDA_SPICE_CATEGORY.test(name) ? "dried" : null)
    ?? (namesFreshVegetableFalseFriend(tokens) ? "fresh" : null)
    ?? "unknown"
  return {
    form: earliestMarker(tokens, FORM_MARKERS) ?? "unknown",
    preservation,
    fatPercent: null,
  }
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
  // canned vs fresh was deliberately permissive and should not have been: "Thunfisch a. d. Dosen"
  // (classified preservation "canned") took BLS's "Thunfisch roh" — raw tuna, 139 kcal/100 g,
  // against 95 for the drained canned record. A candidate that is SILENT about preservation stays
  // acceptable (that is the common case, and attributeFit() prefers a stated match over silence);
  // one that states the OPPOSITE is a contradiction on an axis the query actually specified.
  ["canned", "fresh"],
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
