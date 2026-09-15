/** Shared candidate-ranking helpers for network providers (OFF, USDA) that return multiple hits. */
import type { FoodState, FoodType, FoodAttributes } from "../../types.js"
import { evidenceKey, type IdentityEvidence } from "../identity-evidence.js"
import {
  GERMAN_DESCRIPTOR_WORDS, compoundSpecifier, compoundMatchesTokens, absenceMarkerStem,
  formConflict, preservationConflict, fatConflict, freshVsProcessedFormConflict, inferAttributesFromName, compoundSegments,
  derivedProductConflict, standalonePlantPart, namesDerivedProduct, isDerivedProductMarker, type PlantPart,
} from "./food-semantics.js"
import { normalizeGermanText } from "../../utils/text-normalize.js"

/**
 * PRIMARY hard-rejection signal (checked before any lexical/confidence score): a
 * "simple"/"processed_single_food" query must never accept a "composite_dish" candidate,
 * regardless of how well the candidate's name textually matches. A composite query (e.g. the
 * ingredient genuinely IS "Linsensuppe") may still match a composite candidate.
 *
 * "unknown" is permissive on EITHER side (never itself causes a rejection) — this is the
 * fallback when authoritative provider/classifier metadata isn't available (LLM disabled/failed,
 * or a provider that doesn't expose a food-type signal), so the system degrades to the
 * lexical categoryConflict()/findMismatch() checks below rather than blocking everything.
 *
 * Backed by authoritative metadata, not name-guessing, per provider:
 *   BLS:  the official BLS Code's leading letter (X/Y = "Menükomponenten", composite dishes —
 *         see scripts/import_bls.py) — every live-discovered BLS false positive this project
 *         found (Hasenpfeffer, Schweinepfeffer, Rote-Linsensuppe, Kartoffel-Tomaten-Gratin) was
 *         coded X or Y.
 *   USDA: FoodData Central's own `foodCategory` field (e.g. "Pudding", "Baby Foods", "Cakes and
 *         pies", "Nut & Seed Butters" vs. "Vegetables and Vegetable Products") — see
 *         usda-provider.ts's usdaFoodType().
 */
export function foodTypeConflict(queryFoodType: FoodType, candidateFoodType: FoodType): boolean {
  if (queryFoodType === "unknown" || candidateFoodType === "unknown") return false
  if (queryFoodType === "composite_dish") return false // a composite query may match a composite candidate
  return candidateFoodType === "composite_dish"
}

export function tokenize(s: string): string[] {
  // Defense-in-depth: candidate name/brand fields ultimately come from external provider APIs
  // (OFF, USDA) whose real-world response shape isn't guaranteed to match our TS types at
  // runtime — found live: OFF's `brands` field is actually a string array, not a string, which
  // crashed this function on every real candidate before the callers were fixed to normalize it
  // at their own boundary. Guarding here too means a similarly-shaped surprise from any other
  // provider degrades to "no similarity" instead of crashing the whole lookup.
  if (typeof s !== "string") return []
  // normalizeGermanText(), not .normalize("NFKD") — NFKD decomposes "ö" into "o" + a combining
  // diaeresis, which the char-class strip below then silently deletes as a non-letter, corrupting
  // "Gewürz" into ["gewu", "rz"] instead of one token. See text-normalize.ts.
  return normalizeGermanText(s)
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
}

/**
 * Coarse preparation-state inference from an English candidate name (USDA FoodData Central
 * descriptions are English) — the runtime counterpart to bls-provider.ts's German
 * infer_state (which runs once, at import time, in scripts/import_bls.py, since BLS's own
 * names are fixed at import). Used so USDA candidates can participate in the same
 * queryState-conflict rejection BLS already has (e.g. rejecting "raw" query against a
 * "boiled"/"cooked" candidate) — without this, RankableCandidate.state would never be set for
 * USDA and state conflicts could never be detected there.
 */
const ENGLISH_STATE_PATTERNS: [FoodState, RegExp][] = [
  // "powder" found live: "Kirschtomate" (raw cherry tomato, 200g) matched USDA's "Tomato
  // powder" — a concentrated dehydrated product wildly wrong at that gram quantity — because
  // "powder" wasn't recognized as a dried-state indicator, so no state conflict ever fired
  // against the query's "raw" state.
  ["dried", /\b(dried|dehydrated|dry|powder(ed)?)\b/i],
  // "pickled" found live: raw "Rote Zwiebel" (red onion) matched OFF's "Pickled red onion" — a
  // vinegar-preserved product with a materially different nutrient profile than fresh onion.
  // FoodState has no dedicated "pickled" value, but grouping it with "cooked" still gets the
  // useful behavior: it correctly conflicts with a "raw" query, which is the case that matters.
  ["cooked", /\b(cooked|boiled|baked|fried|roasted|grilled|steamed|braised|poached|stewed|pickled|eingelegt)\b/i],
  // "fresh" found live: "getrocknete Petersilie"/"getrockneter Thymian"/"getrockneter Basilikum"
  // (all explicitly DRIED queries) matched USDA's "Parsley, fresh"/"Thyme, fresh"/"Basil, fresh"
  // — the exact opposite state — because "fresh" wasn't recognized as raw-equivalent, so the
  // dried-vs-raw state conflict never fired against these candidates.
  ["raw", /\b(raw|fresh)\b/i],
]

export function inferStateFromName(name: string): FoodState {
  for (const [state, pattern] of ENGLISH_STATE_PATTERNS) {
    if (pattern.test(name)) return state
  }
  return "unknown"
}

/**
 * Token-overlap similarity in [0, 1], with a substring-containment fallback so German
 * compound words match sensibly (e.g. "Milch" against "Vollmilch 3.5%", which share no
 * token but are clearly related). Cheap and dependency-free; good enough for ranking
 * candidates, not for exact/authoritative matching.
 */
export function nameSimilarity(a: string, b: string): number {
  const ta = new Set(tokenize(a))
  const tb = new Set(tokenize(b))
  if (ta.size === 0 || tb.size === 0) return 0

  let intersection = 0
  for (const t of ta) if (tb.has(t)) intersection++
  const union = new Set([...ta, ...tb]).size
  const jaccard = union === 0 ? 0 : intersection / union

  const flatA = tokenize(a).join("")
  const flatB = tokenize(b).join("")
  const containment = flatA.length > 0 && flatB.length > 0 && (flatA.includes(flatB) || flatB.includes(flatA)) ? 0.5 : 0

  return Math.max(jaccard, containment)
}

/**
 * Generic, food-agnostic quality/state descriptors — words that commonly qualify almost any food
 * without themselves naming a DIFFERENT food (organic, fresh, small, sweet, ...). Excluded from
 * the "extra content" count in coreIdentityScoreAdjustment() so a candidate isn't penalized for
 * harmless descriptive words, while genuine additional food content (chutney, cheese, tapioca,
 * pineapple, ...) still counts. This is a broad, reusable vocabulary of quality/state words that
 * apply across many foods — not a blacklist of specific wrong foods, unlike MISMATCH_RULES below.
 */
export const GENERIC_DESCRIPTOR_WORDS = new Set([
  "raw", "fresh", "cooked", "boiled", "baked", "fried", "roasted", "grilled", "steamed", "braised",
  "poached", "stewed", "dried", "dry", "dehydrated", "frozen", "canned", "organic", "natural",
  "whole", "ground", "pure", "plain", "style", "tender", "petite", "small", "large", "mild",
  "sweet", "ripe", "nfs", "unspecified", "generic", "bottled", "prepared", "unprepared", "extra",
  "premium", "select", "product", "products", "type", "flavor", "flavour", "flavored", "flavoured",
  // "sweet" stays here for ENGLISH candidate names only, and the asymmetry is deliberate: USDA
  // names whole varietal families with it ("Peppers, sweet, raw" IS the ordinary bell pepper, and
  // demoting the word dropped that correct match below the acceptance threshold). Its German
  // counterpart "süß" is NOT in GERMAN_DESCRIPTOR_WORDS, because BLS uses it the other way — as a
  // product qualifier standing beside the neutral variants ("Senf süß" 177 kcal vs "Senf
  // mittelscharf/scharf/extra scharf" 111 kcal). Two corpora, two conventions; this split is the
  // whole reason the two vocabularies are separate.
  //
  // USDA's own classificatory vocabulary — words describing which VARIANT OF A RECORD this is,
  // used across whole families ("Beans, kidney, red, mature seeds, canned, drained solids"). Found
  // live: that record — the correct 124 kcal answer for drained canned kidney beans — lost to the
  // vague "Kidney beans, NFS" (177 kcal, and carrying 6.97 g/100 g of added cooking fat) purely
  // because USDA's precise naming convention cost it four foreign-content penalties while "NFS"
  // cost nothing.
  "mature", "immature", "drained", "solids", "liquids", "enriched", "unenriched", "reconstituted",
  "undiluted", "diluted", "commercially", "commercial", "homemade", "assorted", "types", "variety",
  "varieties", "includes", "excludes", "made", "from",
  // USDA's own classificatory/category-prefix words (e.g. "Spices, cumin seed", "Spices, oregano,
  // dried") — these describe what KIND of database entry it is, not a different food, so they must
  // never count as "extra unexplained content". Found live: their absence regressed several
  // previously-correct spice matches (cumin, coriander, black pepper) to an unnecessary LLM
  // fallback purely because "spices"/"seed" weren't recognized as generic.
  //
  // Deliberately NOT "powder"/"powdered" here, even though the same reasoning might seem to
  // apply: found live, that let "Sahne" (liquid cream) match USDA's "Cream substitute, powdered"
  // — for a query like "Knoblauchpulver" ("garlic powder"), "powder" is already part of the
  // query's OWN text and gets credited as a matched MODIFIER (see coreIdentityScoreAdjustment),
  // so it never needed to be globally generic too — doing so only opened the door to accepting an
  // unrelated candidate's powder FORM as if it were harmless, when powder-vs-liquid is exactly
  // the kind of form difference that matters for cream specifically.
  "spice", "spices", "seed", "seeds", "herb", "herbs",
])

/** Minimum length for a core-identity token to participate in substring containment checks — a
 *  1-2 letter fragment risks matching coincidentally inside an unrelated word. */
const CORE_TOKEN_MIN_LENGTH = 3

function coreTokensOf(coreText: string | null | undefined): string[] {
  if (!coreText) return []
  return tokenize(coreText).filter((t) => t.length >= CORE_TOKEN_MIN_LENGTH)
}

/**
 * PRIMARY structural signal, checked alongside foodTypeConflict and before any lexical score: a
 * candidate whose name contains NONE of the query's core-identity tokens is a different food, no
 * matter how many adjectives/descriptors it happens to share with the query. This is what
 * actually generalizes across cases like "italienische Gewürzmischung" (core: "seasoning")
 * matching USDA's "Salami, Italian, pork" / "Italian Ice" / "Creamy Italian dressing" /
 * "Focaccia, Italian, plain" / "Pastry, Italian, with cheese" — none of those names contain
 * "seasoning" at all — and "chili flakes" (core: "chili") matching "Onions, dehydrated flakes"
 * (no "chili" anywhere), WITHOUT enumerating any of those specific wrong foods by name: whatever
 * "Italian X" or "X flakes" a provider returns next, the mechanism still holds.
 *
 * coreText comes from the LLM's own coreFoodGerman/coreFoodEnglish classification (the base food
 * noun, stripped of modifiers like color/origin/state) — an empty/missing core (LLM
 * disabled/failed, or genuinely unclear) is permissive, matching foodTypeConflict's degrade
 * pattern, so this never blocks everything when the signal isn't available.
 *
 * Uses substring containment (not exact token equality) specifically to handle German
 * compounding: BLS's own "Speisezwiebel" must be recognized as containing the core "zwiebel"
 * even though it's fused into one token, not a separate word.
 */
/**
 * Which language's word-formation rules the core token follows.
 *
 * "compound" (German): a core may appear FUSED inside a candidate token, because German compounds
 * genuinely carry the head noun that way — BLS's "Speisezwiebel" really is a "Zwiebel".
 *
 * "token" (English): the core must BE a candidate token. English does not fuse identity like that,
 * so substring containment there matches unrelated words that merely share letters. Found live:
 * "Gewürzpaste" -> core "spice" was satisfied by USDA's "Spices, allspice, ground" — "allspice"
 * literally contains "spice", so the wrong food's own name passed the gate — and with zero name
 * similarity the candidate still reached exactly MIN_ACCEPTABLE_SCORE and was accepted. Same class
 * as corn/acorn, mint/peppermints, rice/liquorice.
 */
export type CoreMatchMode = "compound" | "token"

/**
 * English token equivalence: the same word, allowing only a regular plural difference.
 *
 * Deliberately just exact equality plus a trailing "s"/"es" on either side — no stemming, no
 * prefix/suffix compounding, no substring containment. That is exactly enough to recover the
 * singular/plural pairs USDA's descriptions produce (tomato/Tomatoes, onion/Onions,
 * carrot/Carrots, lentil/Lentils, spice/Spices) while still refusing the superstring class that
 * caused the live wrong-identity match: "spice" vs "allspice", "corn" vs "acorn", "mint" vs
 * "peppermints", "rice" vs "liquorice" — in each of those the candidate is a DIFFERENT word that
 * merely ends with the core, which no plural rule can turn into a match.
 */
function englishTokenMatches(core: string, token: string): boolean {
  if (core === token) return true
  if (token === `${core}s` || core === `${token}s`) return true
  if (token === `${core}es` || core === `${token}es`) return true
  return false
}

export function coreIdentityConflict(
  coreText: string | null | undefined,
  candidateName: string,
  mode: CoreMatchMode = "compound",
): boolean {
  const coreTokens = coreTokensOf(coreText)
  if (coreTokens.length === 0) return false
  const candidateTokens = tokenize(candidateName)
  const hasCore = coreTokens.some((core) =>
    mode === "token"
      // A GENERIC_DESCRIPTOR token cannot BE the identity evidence. USDA prefixes whole families
      // with a classificatory word ("Spices, allspice, ground", "Herbs, basil, fresh"), so the
      // plural rule would otherwise let core "spice" be satisfied by the prefix "Spices" — which
      // is exactly how "Gewürzpaste" reached "Spices, allspice, ground" in production. This only
      // stops such a token COUNTING as evidence; it never rejects a candidate for containing one,
      // so "cumin" still matches "Spices, cumin seed" via "cumin" and "basil" still matches
      // "Herbs, basil, fresh" via "basil". A query whose only core evidence is itself generic
      // ("spice", "herb", "seed") therefore finds no identity at all and falls back safely,
      // instead of adopting whichever specific food happens to share the family prefix.
      ? candidateTokens.some((t) => !GENERIC_DESCRIPTOR_WORDS.has(t) && englishTokenMatches(core, t))
      // German: containment covers "Zwiebel" inside "Speisezwiebel"; compound segmentation covers
      // the mirror case where the CORE is the fused compound and the record spells it out
      // ("Hähnchenbrust" vs "Hähnchen Brustfilet"). Without the second, supplying a more precise
      // core turned a perfect record into a hard rejection.
      : candidateTokens.some((t) => t.includes(core)) || compoundMatchesTokens(core, candidateTokens),
  )
  return !hasCore
}

/**
 * SECONDARY structural signal: a point ADJUSTMENT (not a hard gate — coreIdentityConflict already
 * handles the "core entirely absent" case) rewarding modifier overlap and penalizing candidate
 * content the query's core + modifiers + generic descriptors don't explain. E.g. "Tapioca Garlic"
 * for a bare "garlic" query has one unexplained word ("tapioca"); "Bell Pepper with Blue cheese"
 * for "green bell pepper" has two ("blue", "cheese"); "Red onion chutney" for "red onion" has one
 * ("chutney"). Each unexplained word is real evidence the candidate is a different or composite
 * product built around the core ingredient, not the ingredient itself — deliberately steep so
 * even ONE unexplained word reliably pushes an otherwise-mediocre textual match below
 * MIN_ACCEPTABLE_SCORE, and two or more pushes almost any match below it, per "a database miss is
 * preferable to a confident wrong match." modifierTokens are derived from the query's own full
 * text (canonicalGerman/canonicalEnglish) minus its core tokens — never hand-authored per food.
 */
export function coreIdentityScoreAdjustment(
  coreText: string | null | undefined,
  fullQueryText: string,
  candidateName: string,
  /** Relaxed second pass: accept a sub-variety when nothing less specific exists — see bls-provider.ts. */
  options: { allowSubVariety?: boolean } = {},
): number {
  const coreTokens = coreTokensOf(coreText)
  if (coreTokens.length === 0) return 0

  const queryTokens = tokenize(fullQueryText)
  // Length-filtered for the same reason core tokens are: modifier credit is granted by substring,
  // so a 1-2 letter token matches almost anything. Found while sweeping the live ingredient list —
  // "Thunfisch a. d. Dose" contributed the modifiers "a" and "d", which then "explained" the
  // "tomatensauce" in "Thunfisch in Tomatensauce, Konserve" (because it contains an "a") and
  // pushed that record above the plain canned tuna it should have lost to.
  const modifierTokens = queryTokens.filter((t) =>
    t.length >= CORE_TOKEN_MIN_LENGTH && !coreTokens.some((c) => t.includes(c) || c.includes(t)))

  const queryNamesDerivedProduct = namesDerivedProduct(fullQueryText)
  const candidateTokens = tokenize(candidateName)
  let modifierMatches = 0
  let extraCount = 0
  for (const t of candidateTokens) {
    if (t.length < CORE_TOKEN_MIN_LENGTH) continue
    // "Halbfettbutter" contains "butter", so containment alone declared it fully explained and it
    // outscored the correct "Butter mild gesäuert". A compound whose PREFIX narrows the core to a
    // sub-variety ("Reis|nudeln", "Eier|teigwaren", "Halbfett|butter") is extra content, not a
    // synonym — unless the query itself asked for that specifier. See compoundSpecifier().
    const specifier = coreTokens.map((c) => compoundSpecifier(t, c, GENERIC_DESCRIPTOR_WORDS)).find(Boolean)
    if (specifier) {
      const asked = modifierTokens.some((m) => m.startsWith(specifier) || specifier.startsWith(m))
      if (!asked && !options.allowSubVariety) { extraCount++; continue }
      if (asked) modifierMatches++
      continue
    }
    if (coreTokens.some((c) => t.includes(c))) continue
    if (modifierTokens.some((m) => t.includes(m) || m.includes(t))) {
      modifierMatches++
      continue
    }
    // A "free-from" word states the ABSENCE of something the query never asked for — descriptive,
    // not foreign content. See absenceMarkerStem(); a query that DOES name the excluded
    // ingredient still pays, which is what keeps "Eiernudeln" away from "Teigwaren eifrei".
    const absent = absenceMarkerStem(t)
    if (absent !== null && !queryTokens.some((q) => q.startsWith(absent) || absent.startsWith(q))) continue
    // The query asked for a derived product and the candidate names one — a DIFFERENT word for the
    // same class ("garlic seasoning" vs "Spices, garlic POWDER"). specificityConflict() already
    // treats the class as satisfied, so charging the candidate 35 points of foreign content for
    // the very word that satisfies it is self-contradictory: it left "Knoblauchgewürz" with the
    // raw-garlic records rejected AND the garlic-powder record below the acceptance threshold.
    if (isDerivedProductMarker(t) && queryNamesDerivedProduct) { modifierMatches++; continue }
    // The query may itself be a fused German compound, in which case the candidate spells its
    // parts as separate words: "Hähnchenbrust" vs "Hähnchen Brustfilet, roh". A candidate token
    // that continues one of the query's own compound segments is content the query ASKED for, so
    // penalising it as foreign is exactly backwards.
    if (queryTokens.some((q) => compoundSegments(q).some(([a, b]) =>
      (t.startsWith(a) || a.startsWith(t)) || (t.startsWith(b) || b.startsWith(t))))) {
      modifierMatches++
      continue
    }
    // German qualifiers count exactly like their English counterparts. Without this, every BLS
    // name's "roh"/"gekocht"/"Konserve" was scored as a DIFFERENT FOOD at -35 and sank the
    // candidate below FUZZY_MIN_SCORE — the defect that made correct classification hurt BLS.
    if (GENERIC_DESCRIPTOR_WORDS.has(t) || GERMAN_DESCRIPTOR_WORDS.has(t)) continue
    extraCount++
  }

  // Found live: "Rote Linse" (red lentil) scored 33/100 against OFF's "Red lentil fusilli" — a
  // pasta product, not the lentil itself — because a single unexplained word ("fusilli") combined
  // with an otherwise-strong textual/modifier match wasn't quite enough to clear -30/word. Bumped
  // to -35, which pushes this and similar single-extra-word-but-high-base-similarity cases below
  // MIN_ACCEPTABLE_SCORE without needing to enumerate "fusilli" (or any other pasta shape) by name.
  return Math.min(modifierMatches, modifierTokens.length) * 8 - extraCount * 35
}

interface MismatchRule {
  queryPattern: RegExp
  forbiddenCandidatePattern: RegExp
  description: string
}

/**
 * Curated obvious-mismatch guards, per the skill's examples (fresh ginger vs ginger ale,
 * salt vs electrolyte drink, coriander vs coriander chutney, ...). Not exhaustive — the
 * general name-similarity/completeness scoring in rankCandidates does most of the work;
 * these exist to hard-block the specific classes of false positive the skill calls out.
 */
const MISMATCH_RULES: MismatchRule[] = [
  { queryPattern: /\b(ingwer|ginger)\b/i, forbiddenCandidatePattern: /\b(ale|soda|drink|getränk|getraenk|limonade)\b/i, description: "ginger vs ginger-flavored drink" },
  { queryPattern: /\b(salz|salt)\b/i, forbiddenCandidatePattern: /\b(electrolyte|elektrolyt|sportgetränk|sportgetraenk|sports? ?drink)\b/i, description: "salt vs electrolyte drink" },
  { queryPattern: /\b(koriander|coriander|cilantro)\b/i, forbiddenCandidatePattern: /\b(chutney)\b/i, description: "coriander vs coriander chutney" },
  { queryPattern: /\b(apfel|apple)\b/i, forbiddenCandidatePattern: /\b(saft|juice|kuchen|pie|cider|chips|mus)\b/i, description: "apple vs apple juice/pie/cider" },
  { queryPattern: /\b(orange)\b/i, forbiddenCandidatePattern: /\b(saft|juice|soda|fanta|limonade)\b/i, description: "orange vs orange juice/soda" },
  { queryPattern: /\b(zitrone|lemon)\b/i, forbiddenCandidatePattern: /\b(soda|limonade|sprite|7up)\b/i, description: "lemon vs lemon soda" },
  { queryPattern: /\b(kaffee|coffee)\b/i, forbiddenCandidatePattern: /\b(likör|liqueur|eiscreme|ice cream)\b/i, description: "coffee vs coffee liqueur/ice cream" },
  { queryPattern: /\b(vanille|vanilla)\b/i, forbiddenCandidatePattern: /\b(eiscreme|ice cream|pudding)\b/i, description: "vanilla vs vanilla ice cream/pudding" },
  // Found live: bare "Wasser"/"Water" (plain water, ~0 kcal) matched USDA's "Water convolvulus,
  // raw" — actually a leafy VEGETABLE (water spinach), not water — via a single shared token. Also
  // found live in the mandatory manual-provenance audit: matched OFF's "Tonic Water" — a
  // sweetened, flavored soft drink with real calories/sugar, not plain water.
  // "kokos"/"coconut" found live: "Wasser" (plain water) matched BLS's "Kokoswasser
  // (Fruchtwasser)" — coconut water, a real product with meaningful sugar/calories, not plain
  // water. coreIdentityConflict alone can't catch this: "wasser" IS a substring of "Kokoswasser"
  // (the core is genuinely present in the compound), so this needs the same lexical treatment as
  // the other qualified-water cases below.
  // "kokos" deliberately has NO trailing \b — "Kokoswasser" is one fused German compound with no
  // word break before "wasser", so a trailing boundary would never match inside it (the same
  // insight COMPOSITE_PRODUCT_MARKERS below already relies on for German compounds).
  { queryPattern: /\b(wasser|water)\b/i, forbiddenCandidatePattern: /\b(convolvulus|chestnut|kastanie|melon|melone|cress|kresse|tonic|sparkling|soda water|mineral|coconut)\b|kokos/i, description: "plain water vs a different food whose name happens to contain \"water\"" },
  // Found live in the mandatory manual-provenance audit, in two separate recipes: bare "Pfeffer"
  // (pepper, the spice) matched OFF's "Dr pepper" — a branded carbonated soft drink, via the
  // single shared word "pepper".
  { queryPattern: /\b(pfeffer|pepper)\b/i, forbiddenCandidatePattern: /\bdr\.?\s*pepper\b/i, description: "pepper (spice) vs the Dr Pepper soft drink brand" },
  // Found live: "rote Paprika"/"grüne Paprika" (bell pepper, a VEGETABLE, translated by the LLM to
  // canonicalEnglish "red/green bell pepper") matched USDA's "Spices, pepper, red or cayenne" — a
  // dried chili SPICE product, via the shared word "pepper". Both "simple" foodType (foodTypeConflict
  // can't catch a within-simple category mismatch), so this needs its own rule. A 90g "vegetable"
  // quantity of cayenne spice nutrition is a severe distortion, not just a labeling nicety.
  { queryPattern: /\bbell pepper\b/i, forbiddenCandidatePattern: /\bspices?,?\s*(pepper|paprika)\b/i, description: "bell pepper (vegetable) vs a dried pepper/paprika SPICE product" },
  // The reverse direction, found live on the very next redeploy after the Dr-Pepper fix above:
  // bare "Pfeffer" (spice) then matched USDA's "Pepper, banana, raw" — a raw VEGETABLE pepper
  // variety (USDA's "Pepper(s), <variety>, raw" naming convention), not the ground spice. Excludes
  // "bell pepper" query text via the negative lookbehind so this never fires for the legitimate
  // vegetable-pepper queries the rule above protects; excludes "black"/"white"/"red or cayenne" from
  // the forbidden side since those ARE the correct spice-side candidates.
  {
    queryPattern: /(?<!bell )\b(pfeffer|pepper)\b(?!\s*,)/i,
    forbiddenCandidatePattern: /^peppers?,\s*(?!black\b|white\b|red or cayenne\b)[a-z]/i,
    description: "pepper (spice) vs a raw vegetable pepper variety (USDA \"Pepper, <variety>, raw\" naming)",
  },
  // Found live: "Minze" (mint, an herb) matched USDA's "Candies, NESTLE, AFTER EIGHT Mints" — a
  // branded chocolate confection, not the herb.
  { queryPattern: /\b(minze|mint)\b/i, forbiddenCandidatePattern: /\b(candy|candies|chocolate|schokolade|bonbon)\b/i, description: "mint (herb) vs mint-flavored candy/chocolate" },
  // A plain meat-cut query (chicken breast/fillet) must not accept a breaded/battered/crumbed
  // composite product — categoryConflict's STRICT_RAW_INGREDIENT_CATEGORIES deliberately excludes
  // "meat"/"poultry" (a sausage can legitimately BE the right meat answer), which otherwise leaves
  // this specific case unguarded. Found live: "Hähnchenbrustfilets" (plain chicken breast) matched
  // "Chicken breast tenders, breaded, uncooked" — a coated product with materially different macros.
  // "\b" before the German compound prefix but deliberately NOT after it (matches
  // COMPOSITE_PRODUCT_MARKERS' own reasoning): "Hähnchenbrustfilets" fuses "brust" directly into
  // "filets" with no space, so a trailing \b would never match inside the compound at all.
  {
    queryPattern: /\b(hähnchenbrust|haehnchenbrust|hähnchenfilet|haehnchenfilet)\w*|\bchicken breast\b|\bchicken fillet\b/i,
    forbiddenCandidatePattern: /\b(breaded|paniert|battered|crumbed|tenders?)\b/i,
    description: "plain chicken breast/fillet vs breaded/battered chicken product",
  },
  // A bare, unqualified "Ei"/"egg" query means the whole egg — it must not accept a candidate
  // that's actually just one part (white or yolk) or an egg-CONTAINING/egg-free composite product.
  // Uses Unicode-aware lookaround rather than \b: JS's \b is ASCII-only and doesn't treat "ö"/"ü"/
  // "ß" as word characters, which would otherwise misfire on unrelated German compounds. The
  // forbidden pattern tolerates a comma separator ("Egg, white, raw") — real USDA/OFF descriptions
  // are comma-separated, not "egg white" as one run of words.
  {
    queryPattern: /(?<!\p{L})(ei|egg)(?!\p{L})/iu,
    forbiddenCandidatePattern: /\begg,?\s*white\b|\begg,?\s*yolk\b|\beiweiß\b|\beiweiss\b|\beigelb\b|\balbumen\b|\begg,?\s*pasta\b|\beierteigwaren\b|\begg,?\s*noodles\b|\beifrei\b/i,
    description: "whole egg vs egg white/yolk/egg-containing or egg-free composite product",
  },
  // "Kirschtomate" (cherry tomato, a vegetable) translated to canonicalEnglish "cherry tomato"
  // matched USDA's "Cherries, sweet, raw" — the FRUIT, via the shared word "cherry"/"cherries".
  // Anchored whole-string checks (not a simple substring test) so a legitimate "Tomatoes, cherry,
  // raw" candidate — which also contains "cherry" — is never wrongly excluded just because
  // "tomato" happens to appear before rather than after "cherry" in its name.
  {
    queryPattern: /\bcherry tomato(es)?\b/i,
    forbiddenCandidatePattern: /^(?!.*tomato).*\bcherr(y|ies)\b/i,
    description: "cherry tomato (a vegetable) vs cherries (the fruit)",
  },
]

/**
 * Generic oil-type descriptors: a candidate whose name is built ENTIRELY from these words (plus
 * "oil" itself) is a genuine generic answer; any other content word means it names a specific
 * type the query never asked for.
 */
// "oel"/"oele" are the NORMALIZED German forms tokenize() produces for "Öl"/"Öle" — without
// them a bare German oil query looks "qualified" to the specificity guard below and the rule would
// silently stop firing for exactly the case it was written for.
const GENERIC_OIL_WORDS = new Set(["oil", "oils", "oel", "oele", "vegetable", "cooking", "salad", "blend", "blended", "plant", "edible", "nfs", "unspecified", "and"])

/**
 * A bare, unqualified "Öl"/"oil" query means generic oil — it must not accept a candidate naming a
 * SPECIFIC oil type the query never asked for (that would be guessing). Found live in the mandatory
 * manual-provenance audit, across THREE separate redeploys: bare "Öl" matched USDA's "Oil, almond",
 * then (after adding "almond" to a name list) "Oil, babassu", then (after a structural "Oil, <type>"
 * comma-format check) "Cottonseed oil" — USDA's Survey (FNDDS) dataset phrases oils as "<type> oil"
 * rather than SR Legacy's "Oil, <type>", so neither a name list nor a single naming-convention regex
 * generalizes. Fixed properly this time: tokenize the candidate name and check whether every token is
 * a recognized GENERIC oil word — if any token isn't, the candidate names something the query didn't.
 */
function genericOilConflict(queryFoodName: string, candidateName: string): boolean {
  // Unicode-aware lookaround (not tokenize(), which NFKD-decomposes "ö" into "o" + a combining
  // diaeresis that then gets stripped as non-letter/number — turning "Öl" into two garbage
  // single-letter tokens ["o","l"], silently breaking any tokenize()-based check on this exact
  // word, found live while writing this function). This same guard already excludes a query that
  // itself names a specific oil (e.g. "Olivenöl", "Kokosöl") — "öl" there is preceded by a letter
  // ("v"/"s"), so the lookbehind fails and the guard below never matches.
  if (!/(?<!\p{L})(öl|oil)(?!\p{L})/iu.test(queryFoodName)) return false

  // The German half of the guard above works by compounding ("Olivenöl" fuses the type onto the
  // word), but an ENGLISH query names the type as a separate word — "olive oil" — where the
  // lookbehind sees a space and lets the rule fire. That made a perfectly specific English query
  // look "unqualified" and rejected USDA's "Oil, olive, salad or cooking". The rule's own stated
  // scope is a BARE, unqualified oil query, so a query carrying any type word of its own is
  // specific and exempt — which is the same test already applied to the candidate below.
  const queryTokens = tokenize(queryFoodName)
  if (queryTokens.some((t) => !GENERIC_OIL_WORDS.has(t) && !GENERIC_DESCRIPTOR_WORDS.has(t))) return false

  const candidateTokens = tokenize(candidateName)
  if (!candidateTokens.includes("oil") && !candidateTokens.includes("oils")) return false
  return !candidateTokens.every((t) => GENERIC_OIL_WORDS.has(t))
}

/**
 * ASYMMETRIC-SPECIFICITY gate, shared by every provider: a candidate may be BROADER than the query
 * (Basmati rice -> generic polished rice is a legitimate, honest fallback), but it must not be
 * NARROWER in a way the query never asked for.
 *
 * Two independent directions, both found live and neither previously checked:
 *
 *   query narrower than candidate — "Knoblauchgewürz" (a seasoning) accepted "Garlic, raw";
 *     "Gurkenwasser" (pickle brine) accepted "Cucumber, raw". The unmatched query words cost
 *     nothing, because only unexplained CANDIDATE content was ever penalized.
 *
 *   candidate narrower than query — an ambiguous "Koriander" accepted "Spices, coriander seed"
 *     (298 kcal) while the database equally offered "Coriander (cilantro) leaves, raw" (23 kcal).
 *     Picking one is a guess between two different foods, so `availableParts` lets the caller pass
 *     what the whole candidate SET offers: a part is only refused when the data itself shows the
 *     query is ambiguous, so a food whose only form in the database is a seed (cumin, sesame,
 *     mustard seed) still resolves normally.
 */
export function specificityConflict(
  queryFoodName: string,
  queryCoreFood: string | null | undefined,
  queryAttributes: FoodAttributes | undefined,
  candidateName: string,
  availableParts: ReadonlySet<PlantPart>,
): string | null {
  if (derivedProductConflict(queryFoodName, queryCoreFood, candidateName)) {
    return `derived-product conflict: "${queryFoodName}" names a seasoning/liquid/concentrate the candidate is not ("${candidateName}")`
  }

  const part = standalonePlantPart(candidateName)
  if (part && availableParts.size > 1 && (queryAttributes?.form ?? "unknown") === "unknown") {
    // The query named no part but is one of several — never invent which one.
    const queryNamesPart = standalonePlantPart(queryFoodName) ?? standalonePlantPart(queryCoreFood ?? "")
    if (!queryNamesPart) {
      return `ambiguous plant part: "${queryFoodName}" does not say which part, and the database offers ${[...availableParts].join("/")} ("${candidateName}")`
    }
  }
  return null
}

/** The distinct plant parts a candidate set offers — the ambiguity evidence specificityConflict() needs. */
export function availablePlantParts(candidateNames: Iterable<string>): Set<PlantPart> {
  const parts = new Set<PlantPart>()
  for (const name of candidateNames) {
    const part = standalonePlantPart(name)
    if (part) parts.add(part)
  }
  return parts
}

/** Returns a description of the violated rule, or null if no obvious mismatch applies. */
export function findMismatch(queryFoodName: string, candidateName: string): string | null {
  if (genericOilConflict(queryFoodName, candidateName)) {
    return "generic oil vs a specific oil type the query never named"
  }

  for (const rule of MISMATCH_RULES) {
    const queryAsksForForbidden = rule.forbiddenCandidatePattern.test(queryFoodName)
    if (queryAsksForForbidden) continue // the query itself legitimately names the "forbidden" thing
    if (rule.queryPattern.test(queryFoodName) && rule.forbiddenCandidatePattern.test(candidateName)) {
      return rule.description
    }
  }
  return null
}

export interface RankableCandidate {
  name: string
  brand: string | null
  hasCompleteNutrients: boolean
  /** Candidate's own reported/inferred preparation state, when the provider exposes one. */
  state?: FoodState
  /** Provider-specific dataset tier (e.g. USDA dataType) — see RankOptions.dataTypeScore. */
  dataType?: string | null
  /** Candidate's own food type, from authoritative provider metadata — see foodTypeConflict(). */
  foodType?: FoodType
}

export interface RankedCandidate<T> {
  candidate: T
  score: number
  mismatchReason: string | null
}

/**
 * Query categories narrow enough that a "composite/manufactured product" name is almost never a
 * correct match — a raw spice, herb, or piece of produce is not the same food as a sausage, soup,
 * snack, cake, or beverage that merely contains or references it. Deliberately excludes broader
 * categories like "meat"/"poultry"/"fish", where a product form (e.g. sausage) can legitimately BE
 * the right answer.
 */
const STRICT_RAW_INGREDIENT_CATEGORIES = new Set([
  "spice", "herb", "seasoning", "vegetable", "fruit", "dairy", "egg", "grain", "legume", "fat", "oil", "condiment",
  "beverage", "liquid", "water",
])

/**
 * Name markers signaling a composite/manufactured product, and the category they imply.
 * Deliberately WITHOUT a leading `\b` for most markers: German compounds fuse without a space
 * ("Paprikaspeckwurst", "Kartoffelchips"), so a leading word-boundary would never match inside
 * them — the same insight bls-provider.ts's own suffix-compound matching relies on. Short,
 * English loanword markers that risk an accidental substring hit inside an unrelated word
 * ("tea" inside "steak", "ale" inside "kale") keep both boundaries.
 */
const COMPOSITE_PRODUCT_MARKERS: { pattern: RegExp; impliesCategory: string }[] = [
  // Found live: "italienische Gewürzmischung" (Italian spice mix) matched USDA's "Salami,
  // Italian, pork" — a cured meat, unrelated to the seasoning blend, via the shared word "Italian".
  { pattern: /wurst|sausage|salami|prosciutto|pepperoni|\bbacon\b|\bham\b|schinken|speck/i, impliesCategory: "meat-product" },
  // "stuffed"/"curry" found live: "grüne Paprika" (raw green bell pepper) matched "Stuffed green
  // pepper, Puerto Rican style"; "Rote Linse" (raw red lentil) matched "Lentil curry" — both
  // whole prepared dishes built AROUND the query ingredient, not the ingredient itself.
  // "sauce"/"dressing" found live in the mandatory manual-provenance audit: "grüne Paprika" (raw
  // green bell pepper) matched OFF's "Green Pepper Sauce"; "Kirschtomate" (raw cherry tomato)
  // matched USDA's "Tomato products, canned, sauce, with tomato tidbits"; "italienische
  // Gewürzmischung" (a dry spice blend) matched USDA's "Creamy Italian dressing" — a liquid
  // condiment/composite product in every case, not the raw ingredient or dry seasoning itself.
  { pattern: /suppe|eintopf|\bstuffed\b|\bcurry\b|\bsoup\b|\bstew\b|chowder|\bsauce\b|so(ß|ss)e|\bdressing\b/i, impliesCategory: "prepared-dish" },
  // "chutney" found live: "Rote Zwiebel" (raw red onion) matched OFF's "Red onion chutney" — a
  // cooked, vinegar/sugar-preserved condiment, not the raw vegetable. Grouped with other
  // preserve-style condiments that are never the correct answer for a raw-vegetable query.
  { pattern: /chutney|relish|marmalade|compote/i, impliesCategory: "preserved-condiment" },
  // Found live: "Paprikapulver" (a dry spice) matched OFF's "Paprika Frischkäsezubereitung" — a
  // paprika-flavored cream cheese SPREAD, a dairy product wholly unrelated to the spice itself.
  // "cheese,? cream" (reversed order) found live: "Sahne" (liquid cream) matched USDA's "Cheese,
  // cream" — USDA's "Cheese, <descriptor>" naming convention puts the category word FIRST, the
  // reverse of English "cream cheese", so the forward-order pattern alone missed it.
  { pattern: /frischkäse|frischkaese|cream cheese|cheese,?\s*cream|\bspread\b/i, impliesCategory: "dairy-product" },
  { pattern: /stangen|brezel|chips|pretzel|\bsnack\b/i, impliesCategory: "snack" },
  // "focaccia" found live: "italienische Gewürzmischung" (a dry Italian spice blend) matched
  // USDA's "Focaccia, Italian, plain" — the same "shared descriptive word only" failure class as
  // the Salami/Italian-Ice/dressing cases above, just a different specific baked good. This
  // "Italian X" pattern is a known long tail (see final report) — the underlying weakness is that
  // a single shared adjective token can carry too much weight in nameSimilarity for a multi-word
  // query; each specific collision found live is patched here, but this is not an exhaustive fix.
  { pattern: /kuchen|torte|\bcake\b|gebäck|cookie|biscuit|brot|\bbread\b|focaccia/i, impliesCategory: "baked-good" },
  { pattern: /limonade|saft|getränk|juice|drink|\b(soda|cola|tea|tee|ale)\b/i, impliesCategory: "beverage" },
  // Found live: "italienische Gewürzmischung" (Italian spice mix) matched "Italian Ice" (a frozen
  // dessert); "Kirschtomate" (raw cherry tomato) matched "Cobbler, cherry" (a fruit dessert) —
  // both via a single shared descriptive word ("Italian"/"cherry"), unrelated to the actual food.
  { pattern: /\bice\b|sorbet|cobbler|\bpie\b|dessert|pudding|gelato/i, impliesCategory: "dessert" },
  // Found live: "Hähnchenbrustfilets" (plain chicken breast) matched "Chicken breast tenders,
  // breaded, uncooked" — a coated/composite product with significantly different macros
  // (added carbs/fat from the breading) than the plain cut the query actually named.
  { pattern: /breaded|paniert|battered|\bcrumbed\b/i, impliesCategory: "processed-product" },
  // German dish-naming convention: MEAT-PREFIX + dish-type suffix names a whole prepared dish,
  // not the suffix word's literal food identity. Found live: "Schweinepfeffer" ("Schweine-" =
  // pork + "-pfeffer", a savoury pork goulash) matched a bare "Pfeffer" (pepper spice) query via
  // BLS's own compound-suffix rule, since "schweinepfeffer" genuinely does end in "pfeffer" —
  // that rule can't distinguish "a type of X" (Speisezwiebel/Zwiebel) from "a dish named with X
  // as its stylistic suffix" (Schweinepfeffer/Pfeffer, Rehpfeffer/Pfeffer) on string shape alone.
  // Requires a continuation after the prefix (\w+) so the bare animal word alone (e.g. "Schwein")
  // is never flagged, and excludes an "ei"/"eier" (egg) continuation specifically — "Hühnerei"
  // (chicken's EGG, a confirmed-correct BLS match found earlier) is animal-prefix + egg, not
  // animal-prefix + dish-suffix, and must not collide with this rule.
  // "hase" excludes an "ln" continuation too — "Haselnuss" (hazelnut) starts with "hase" but is
  // not remotely rabbit-related; "Hasenpfeffer" (rabbit pepper stew) is the real target.
  { pattern: /\b(schweine|rinder|kalbs|lamm|hähnchen|haehnchen|hühner|huehner|enten|puten|wild|reh|hase)(?!ei\b|eier\b|ln)\w+/i, impliesCategory: "meat-dish" },
]

/**
 * Reusable category-compatibility check: true when `candidateName` reads as a composite/
 * manufactured product (per COMPOSITE_PRODUCT_MARKERS) that conflicts with a known, strict raw-
 * ingredient `queryCategory`. Generalizes several live-discovered failure classes under one
 * mechanism instead of one-off ingredient exceptions: "Paprikapulver" (spice) matching
 * "Paprikaspeckwurst" (meat-product), "Salz" (seasoning) matching "Salzstangen" (snack),
 * "Koriander" (herb) matching a lentil-soup dish (prepared-dish), "Ingwer" (spice) matching
 * ginger ale (beverage). Returns false whenever the query category is unknown or not in the
 * strict set (e.g. "meat" legitimately matches a sausage).
 */
export function categoryConflict(queryCategory: string | null | undefined, candidateName: string): boolean {
  if (!queryCategory) return false
  const normalized = queryCategory.trim().toLowerCase()
  if (!STRICT_RAW_INGREDIENT_CATEGORIES.has(normalized)) return false
  return COMPOSITE_PRODUCT_MARKERS.some((m) => m.pattern.test(candidateName) && m.impliesCategory !== normalized)
}

export interface RankOptions {
  /** Query's known preparation state — a known conflict with a known candidate state is hard-rejected. */
  queryState?: FoodState
  /** Query's known category — see categoryConflict(). Lexical/secondary — foodType is checked first. */
  queryCategory?: string | null
  /** Query's known food type — the PRIMARY hard-rejection signal. See foodTypeConflict(). */
  queryFoodType?: FoodType
  /**
   * Query's core food-identity noun (e.g. "seasoning" for "Italian seasoning", "onion" for "red
   * onion"), from the LLM's coreFoodGerman/coreFoodEnglish classification — a second PRIMARY
   * hard-rejection signal alongside queryFoodType. See coreIdentityConflict()/
   * coreIdentityScoreAdjustment(). Absent/null is permissive.
   */
  /** Query attributes — see FoodAttributes. Gated before any lexical scoring. */
  queryAttributes?: FoodAttributes
  /**
   * Candidate fat per 100 g, when the provider can supply it. Compared against
   * queryAttributes.fatPercent using measured values rather than names.
   */
  candidateFat?: (candidate: unknown) => number | null
  /**
   * Generic route with no brand evidence: a BRANDED candidate is a manufacturer's product standing
   * in for a basic food. Found live — plain "Parmesan" took "Billa Bio Parmesan", "pasta" took a
   * branded pasta, "Baby-Spinat" took a Kroger product. Rejected outright rather than nudged,
   * because the previous -15 penalty was routinely outweighed by a good lexical score.
   */
  rejectBrandedWithoutBrandEvidence?: boolean
  queryCoreFood?: string | null
  /**
   * Word-formation rules for queryCoreFood. English callers (OFF/USDA) must pass "token" so a core
   * cannot be satisfied by containment inside an unrelated word; German (BLS) keeps "compound".
   */
  coreMatchMode?: CoreMatchMode
  /** Scores a provider-specific dataset tier (e.g. USDA dataType) as a ranking signal, not a hard filter. */
  dataTypeScore?: (dataType: string | null | undefined) => number
}

/**
 * Scores and sorts candidates (highest first). Never blindly takes the first search result —
 * callers should reject a candidate whose top score is below a sane threshold or whose
 * mismatchReason is set, and fall through to the next provider.
 */
export function rankCandidates<T extends RankableCandidate>(
  queryFoodName: string,
  queryBrand: string | null,
  candidates: T[],
  options: RankOptions = {},
): RankedCandidate<T>[] {
  // Ambiguity evidence is a property of the candidate SET, so it is computed once, over the
  // candidates that actually name the queried food — a "Coriander chutney" that fails the core
  // gate must not count as evidence that coriander comes in several parts.
  const parts = availablePlantParts(
    candidates
      .filter((c) => !coreIdentityConflict(options.queryCoreFood, c.name, options.coreMatchMode))
      .map((c) => c.name),
  )

  return candidates
    .map((candidate) => {
      // Hard type-compatibility check FIRST, before any lexical/confidence scoring — a high
      // textual score must never rescue a semantic type mismatch (a simple query accepting a
      // composite-dish candidate). Checked ahead of, and independent of, the lexical
      // categoryConflict/findMismatch checks below, which remain as a secondary/defense-in-depth
      // layer for providers or cases where authoritative foodType metadata isn't available.
      let mismatchReason: string | null = foodTypeConflict(options.queryFoodType ?? "unknown", candidate.foodType ?? "unknown")
        ? `food type conflict: a "${options.queryFoodType}" query cannot accept a "composite_dish" candidate ("${candidate.name}")`
        : null

      // Attribute gates rank alongside foodTypeConflict as PRIMARY signals: a nutritionally
      // meaningful form/preservation/fat difference is a different food, not a worse text match.
      const qa = options.queryAttributes
      if (!mismatchReason && qa) {
        const ca = inferAttributesFromName(candidate.name)
        if (formConflict(qa.form, ca.form) || freshVsProcessedFormConflict(qa.preservation, ca.form)) {
          mismatchReason = `form conflict: a "${qa.form}" query cannot accept a "${ca.form}" candidate ("${candidate.name}")`
        } else if (preservationConflict(qa.preservation, ca.preservation)) {
          mismatchReason = `preservation conflict: a "${qa.preservation}" query cannot accept a "${ca.preservation}" candidate ("${candidate.name}")`
        } else if (fatConflict(qa.fatPercent, options.candidateFat?.(candidate) ?? null)) {
          mismatchReason = `fat conflict: ${qa.fatPercent}% requested, candidate has ${options.candidateFat?.(candidate)}g/100g ("${candidate.name}")`
        }
      }

      // Generic route, no brand evidence: an arbitrary manufacturer's product must not stand in
      // for a basic food when an authoritative generic record exists.
      if (!mismatchReason && options.rejectBrandedWithoutBrandEvidence && !queryBrand && candidate.brand) {
        mismatchReason = `branded product for a generic query ("${candidate.brand}" / "${candidate.name}")`
      }

      // Second PRIMARY hard-rejection signal, checked right alongside foodTypeConflict: a
      // candidate whose name contains NONE of the query's core-identity tokens is a different
      // food regardless of any shared adjective/descriptor. See coreIdentityConflict().
      mismatchReason = mismatchReason ?? (coreIdentityConflict(options.queryCoreFood, candidate.name, options.coreMatchMode)
        ? `core identity conflict: "${options.queryCoreFood}" is absent from candidate name ("${candidate.name}")`
        : null)

      // Asymmetric specificity — see specificityConflict(). Ranked with the other PRIMARY gates:
      // introducing or dropping a nutritionally meaningful attribute is a different food, not a
      // weaker text match.
      mismatchReason = mismatchReason ?? specificityConflict(
        queryFoodName, options.queryCoreFood, options.queryAttributes, candidate.name, parts,
      )

      mismatchReason = mismatchReason ?? findMismatch(queryFoodName, candidate.name)

      const similarity = nameSimilarity(queryFoodName, candidate.name)

      // A candidate must carry SOME positive identity evidence before the completeness/dataType
      // bonuses below are allowed to carry it over MIN_ACCEPTABLE_SCORE. Those bonuses are
      // name-independent (+15 for complete nutrients, up to +20 for a good USDA dataType tier),
      // so together they reach 35 — above the threshold — for a candidate whose name has NOTHING
      // in common with the query. Gating on similarity ALONE would be wrong: a matched core token
      // is real identity evidence even at zero whole-token similarity — "bell pepper" vs USDA's
      // "Peppers, sweet, raw" shares no exact token ("pepper" != "peppers") and neither flattened
      // string contains the other, yet it is the correct match. So the gate requires the absence
      // of BOTH signals, which in practice means the whole-recipe LLM classification was
      // unavailable and every ingredient degraded to coreFood=null — exactly the failure mode in
      // which the primary semantic gates are already gone, so an arbitrary top-ranked food would
      // otherwise be accepted and written to Mealie as a confident result.
      const hasCoreEvidence = coreTokensOf(options.queryCoreFood).length > 0
      if (!mismatchReason && similarity === 0 && !hasCoreEvidence) {
        mismatchReason = `no identity evidence: candidate name shares nothing with the query and no core-identity signal is available ("${candidate.name}")`
      }

      let score = similarity * 60
      score += coreIdentityScoreAdjustment(options.queryCoreFood, queryFoodName, candidate.name)

      if (queryBrand && candidate.brand) {
        score += nameSimilarity(queryBrand, candidate.brand) > 0.5 ? 25 : -15
      }

      score += candidate.hasCompleteNutrients ? 15 : -50

      const queryState = options.queryState
      if (!mismatchReason && queryState && queryState !== "unknown" && candidate.state && candidate.state !== "unknown" && candidate.state !== queryState) {
        mismatchReason = `state conflict: query wants "${queryState}", candidate is "${candidate.state}"`
      }

      if (!mismatchReason && categoryConflict(options.queryCategory, candidate.name)) {
        mismatchReason = `category conflict: "${options.queryCategory}" query looks unrelated to a composite/manufactured product name`
      }

      if (options.dataTypeScore) {
        score += options.dataTypeScore(candidate.dataType)
      }

      if (mismatchReason) score -= 1000

      return { candidate, score, mismatchReason }
    })
    .sort((a, b) => b.score - a.score)
}

/** Minimum score (out of the ~100 max above) to accept the top-ranked candidate at all. */
export const MIN_ACCEPTABLE_SCORE = 30

/** The acceptance-relevant query context, as it exists at cache-hit time. */
export interface MatchingContext {
  /** The query text the provider searched with (canonicalEnglish, or the German variant for BLS). */
  foodName: string
  category: string | null
  foodType: FoodType
  /** coreFoodGerman or coreFoodEnglish, whichever language this provider matched in. */
  coreFood: string | null | undefined
  /** Must mirror the RankOptions value the provider ranks with, so a cache hit is revalidated
   * under the SAME identity rules that would apply to a fresh lookup. */
  coreMatchMode?: CoreMatchMode
  /** Identity capabilities in force for this lookup — see evidenceKey(). */
  evidence?: IdentityEvidence
  /** Query attributes, so the specificity gates apply to a cached candidate too. */
  attributes?: FoodAttributes
}

/**
 * Compact, stable serialization of the acceptance-relevant context fields that are deliberately
 * absent from the positive cache key (category/foodType/coreFood).
 *
 * Used ONLY to scope the NEGATIVE cache. A negative entry means "nothing this provider returned
 * was acceptable" — which is a statement about the rules that were applied, not about the food, so
 * it is only meaningful for the context that produced it. Unlike a positive entry, there is no
 * stored candidate to re-validate against (see cachedMatchConflict), so the context has to be part
 * of the key instead. Verified against the live providers: without this, a "simple" query that
 * rejected every candidate recorded a miss that then suppressed a "composite_dish" query for the
 * same food text — which would have accepted one of those very candidates — without even issuing
 * the request.
 *
 * The positive key is deliberately left unscoped: fragmenting it would multiply OFF/USDA calls,
 * and cachedMatchConflict already covers it for free.
 */
export function matchingContextKey(ctx: MatchingContext): string {
  // The evidence profile changes what a provider will ACCEPT, so two lookups with different
  // evidence are different questions: a strict degraded miss must never suppress a later healthy
  // lookup, and vice versa. Omitted evidence keeps the pre-evidence key shape.
  const core = ctx.coreFood ? tokenize(ctx.coreFood).join(" ") : ""
  const category = ctx.category ? tokenize(ctx.category).join(" ") : ""
  const evidence = ctx.evidence ? `|ev=${evidenceKey(ctx.evidence)}` : ""
  return `${category}|${ctx.foodType}|${core}${evidence}`
}

/**
 * Re-runs the name-based acceptance gates against an ALREADY-CACHED match, and returns a reason
 * when that cached match is not acceptable for THIS query's context (or null when it still is).
 *
 * provider_match_cache is keyed by query text (+ state/route/brand) — deliberately NOT by
 * category/foodType/coreFood, because those are free-text/low-stability LLM outputs and folding
 * them into the key would fragment the cache badly (more OFF/USDA calls, more rate-limit
 * pressure) without being necessary: everything they gate can instead be re-checked for free
 * against the stored candidate, since the candidate's own product name and foodType are already
 * persisted. Without this, a cache hit bypassed EVERY semantic gate — resolveNutrients only
 * re-checks nutrient plausibility — so a match cached under one ingredient's context could be
 * served verbatim for a semantically different ingredient that happened to normalize to the same
 * query text.
 *
 * An unacceptable cached entry must behave as a TRUE CACHE MISS for this context: the provider
 * falls through to a fresh lookup and re-ranks under the current context. It must NOT report "no
 * match" — verified against the live providers that doing so hid a perfectly valid alternative
 * candidate from the SAME provider (a composite entry occupying the slot made the simple entry
 * unreachable) for the full CACHE_MATCH_TTL, with whichever context populated the slot first
 * silently winning. The fresh lookup is still guarded by the context-scoped negative cache (see
 * matchingContextKey), so a repeated query that genuinely has no acceptable candidate does not
 * re-issue the request.
 */
export function cachedMatchConflict(
  cached: { productName: string | null; foodType?: FoodType },
  ctx: MatchingContext,
): string | null {
  const candidateName = cached.productName
  if (!candidateName) return null

  if (foodTypeConflict(ctx.foodType, cached.foodType ?? "unknown")) {
    return `food type conflict on cached match: a "${ctx.foodType}" query cannot accept a "composite_dish" candidate ("${candidateName}")`
  }
  if (coreIdentityConflict(ctx.coreFood, candidateName, ctx.coreMatchMode)) {
    return `core identity conflict on cached match: "${ctx.coreFood}" is absent from candidate name ("${candidateName}")`
  }
  // The derived-product half of specificityConflict() is a property of the query and the single
  // stored candidate, so it revalidates for free. The plant-part half deliberately does NOT: it is
  // evidence about the whole candidate SET, which a cache entry does not preserve — instead the
  // attribute triple is part of every provider's positive key, so a cached match can never be
  // served to a query with different form/preservation/fat in the first place.
  if (derivedProductConflict(ctx.foodName, ctx.coreFood, candidateName)) {
    return `derived-product conflict on cached match: "${ctx.foodName}" names a seasoning/liquid/concentrate that "${candidateName}" is not`
  }
  const mismatch = findMismatch(ctx.foodName, candidateName)
  if (mismatch) return `obvious mismatch on cached match: ${mismatch} ("${candidateName}")`
  if (categoryConflict(ctx.category, candidateName)) {
    return `category conflict on cached match: "${ctx.category}" query looks unrelated to "${candidateName}"`
  }
  return null
}
