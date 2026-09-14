/** Shared candidate-ranking helpers for network providers (OFF, USDA) that return multiple hits. */

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
}

export interface RankedCandidate<T> {
  candidate: T
  score: number
  mismatchReason: string | null
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
): RankedCandidate<T>[] {
  return candidates
    .map((candidate) => {
      const mismatchReason = findMismatch(queryFoodName, candidate.name)
      let score = nameSimilarity(queryFoodName, candidate.name) * 60

      if (queryBrand && candidate.brand) {
        score += nameSimilarity(queryBrand, candidate.brand) > 0.5 ? 25 : -15
      }

      score += candidate.hasCompleteNutrients ? 15 : -50
      if (mismatchReason) score -= 1000

      return { candidate, score, mismatchReason }
    })
    .sort((a, b) => b.score - a.score)
}

/** Minimum score (out of the ~100 max above) to accept the top-ranked candidate at all. */
export const MIN_ACCEPTABLE_SCORE = 30
