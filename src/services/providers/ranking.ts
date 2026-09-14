/** Shared candidate-ranking helpers for network providers (OFF, USDA) that return multiple hits. */
import type { FoodState, FoodType } from "../../types.js"

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
  return s
    .toLowerCase()
    .normalize("NFKD")
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
  ["cooked", /\b(cooked|boiled|baked|fried|roasted|grilled|steamed|braised|poached|stewed)\b/i],
  ["raw", /\braw\b/i],
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
  // raw" — actually a leafy VEGETABLE (water spinach), not water — via a single shared token.
  { queryPattern: /\b(wasser|water)\b/i, forbiddenCandidatePattern: /\b(convolvulus|chestnut|kastanie|melon|melone|cress|kresse)\b/i, description: "plain water vs a different food whose name happens to contain \"water\"" },
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
  // A bare, unqualified "Öl"/"oil" query means generic oil — it must not accept a candidate naming
  // a SPECIFIC oil type the query never asked for (that would be guessing). A query that itself
  // names a specific oil (e.g. "Olivenöl") is unaffected — forbiddenCandidatePattern.test(query)
  // short-circuits the rule for it, same mechanism as every other rule here.
  {
    queryPattern: /(?<!\p{L})(öl|oil)(?!\p{L})/iu,
    forbiddenCandidatePattern: /\b(coconut|kokos|olive|oliven|sesame|sesam|sunflower|sonnenblumen|canola|raps|palm|walnut|walnuss|avocado|peanut|erdnuss|corn|maiskeim|flaxseed|leinsamen)\b/i,
    description: "generic oil vs a specific oil type the query never named",
  },
]

/** Returns a description of the violated rule, or null if no obvious mismatch applies. */
export function findMismatch(queryFoodName: string, candidateName: string): string | null {
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
  { pattern: /suppe|eintopf|\bstuffed\b|\bcurry\b|\bsoup\b|\bstew\b|chowder/i, impliesCategory: "prepared-dish" },
  { pattern: /stangen|brezel|chips|pretzel|\bsnack\b/i, impliesCategory: "snack" },
  { pattern: /kuchen|torte|\bcake\b|gebäck|cookie|biscuit|brot|\bbread\b/i, impliesCategory: "baked-good" },
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

      mismatchReason = mismatchReason ?? findMismatch(queryFoodName, candidate.name)

      let score = nameSimilarity(queryFoodName, candidate.name) * 60

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
