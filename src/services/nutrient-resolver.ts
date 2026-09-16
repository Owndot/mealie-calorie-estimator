import { getProviderChain } from "./providers/registry.js"
import { sanityCheckNutrients } from "./sanity-check.js"
import { statedModifierFamilies } from "./providers/food-semantics.js"
import { logger } from "../utils/logger.js"
import type { ProviderQuery } from "./providers/types.js"
import type { FoodRoute, FallbackStatus, ProviderMatch } from "../types.js"

export interface ResolvedNutrients {
  match: ProviderMatch
  fallbackStatus: FallbackStatus
}

const KNOWN_FALLBACK_STATUSES: FallbackStatus[] = ["mealie-recipe", "bls", "usda-local", "off", "llm-nutrient"]

/**
 * Maps a provider's `name` to a FallbackStatus without an unchecked cast — a provider whose name
 * doesn't match one of the known values would otherwise silently produce an invalid
 * fallbackStatus (this happened once already: the LLM provider was named "llm" while
 * FallbackStatus expected "llm-nutrient", so llmParticipated/provenance silently lost track of
 * LLM-resolved ingredients). Falls back to "unresolved" and logs loudly so a future rename can't
 * fail silently the same way.
 */
function toFallbackStatus(providerName: string): FallbackStatus {
  const match = KNOWN_FALLBACK_STATUSES.find((s) => s === providerName)
  if (match) return match
  logger.warn({ providerName }, "Provider name does not match any known FallbackStatus — check for a naming mismatch")
  return "unresolved"
}

/**
 * Walks the routing-aware provider chain for one ingredient, preferring a candidate that satisfies
 * the ingredient's MATERIAL NUTRITIONAL ATTRIBUTES over one that merely shares its identity.
 *
 * The chain used to stop at the first provider that returned anything, which made provider order
 * the only thing that mattered. Two production cases showed why that is not enough:
 *
 *   "mageres Rinderhackfleisch" -> BLS "Rind Hackfleisch, roh", unmetAttributes ["reduced-fat"].
 *      Correct base food, explicit "mager" dropped, 224 kcal/100 g at 16.4% fat — and at 400 g that
 *      ingredient is ~35% of the recipe.
 *   "Mayo Light" -> BLS "Salatmayonnaise", unmetAttributes ["reduced-fat"], while USDA holds an
 *      actual "Mayonnaise, light" record at 238 kcal against BLS's 490.
 *
 * In both, the system already KNEW the attribute was unmet and used the record anyway. So an
 * attribute shortfall no longer ends the search: the match is remembered and the chain continues.
 *
 * But continuing is not the same as replacing, and the first version of this conflated them. A
 * later match displaces the remembered one ONLY IF it positively answers the claim — its own record
 * name has to state it. Anything else keeps the database record, flagged. Production showed why the
 * weaker rule was wrong: for "mageres Rinderhackfleisch" the chain reached an LLM estimate of 250
 * kcal/100 g, MORE than the 224 kcal ordinary mince it displaced, and the resolver announced that
 * it satisfied "reduced-fat" — on no evidence beyond the estimate having no name to check.
 *
 * Food identity remains the hard requirement throughout — nothing here can promote a candidate
 * that failed the semantic gates, because such a candidate never reaches this function. This
 * chooses between records that are all already the right food.
 */
/**
 * Which of the shortfall's unmet claims this candidate does NOT positively answer.
 *
 * `unmetAttributes` is computed from the candidate's own NAME (unmetModifierFamilies), so a
 * provider that has no record name never computes it and reports nothing — indistinguishable, from
 * the outside, from a provider that checked and found nothing wrong. Reading that silence as
 * "satisfied" is what let a 250 kcal/100 g estimate displace a 224 kcal database record for
 * "mageres Rinderhackfleisch": the estimate was MORE energy-dense than the ordinary mince it
 * replaced, and the only thing that made it look leaner was that nobody had asked.
 *
 * So the question is asked the other way round. Displacing an identity-compatible record because
 * of a claim requires the replacement to make that claim itself, in a form something can read. A
 * record with no name states nothing and answers nothing.
 *
 * Numeric percentages deliberately play no part here: a stated percentage is a hard gate upstream
 * (fatConflict), never a modifier family, so it can never appear in a shortfall's unmet list and
 * there is nothing for it to answer.
 */
function unansweredBy(match: ProviderMatch, unmet: string[]): string[] {
  const stated = statedModifierFamilies(match.productName ?? "")
  return unmet.filter((family) => !stated.includes(family))
}

export async function resolveNutrients(query: ProviderQuery, route: FoodRoute): Promise<ResolvedNutrients | null> {
  const chain = getProviderChain(route)

  // Highest-trust match that shares the identity but drops a stated nutritional claim. Kept in
  // case nothing better turns up; the chain is ordered by trust, so the first one found is the one
  // worth keeping.
  let shortfall: ResolvedNutrients | null = null

  for (const provider of chain) {
    let match: ProviderMatch | null
    try {
      match = await provider.lookup(query)
    } catch (err) {
      logger.warn({ err, provider: provider.name, foodName: query.foodName }, "Provider lookup failed")
      continue
    }

    if (!match) continue

    const check = sanityCheckNutrients(match.nutrients, query.foodName)
    if (!check.ok) {
      logger.info({ provider: provider.name, foodName: query.foodName, reason: check.reason }, "Rejected candidate on sanity check")
      continue
    }

    const resolved = { match, fallbackStatus: toFallbackStatus(provider.name) }

    if ((match.unmetAttributes?.length ?? 0) === 0) {
      // Nothing to displace: first acceptable match wins, exactly as before.
      if (!shortfall) return resolved

      const unanswered = unansweredBy(match, shortfall.match.unmetAttributes ?? [])
      if (unanswered.length > 0) {
        logger.info(
          {
            foodName: query.foodName, provider: provider.name, record: match.productName,
            unanswered, keeping: shortfall.fallbackStatus, keepingRecord: shortfall.match.productName,
          },
          "Attribute-aware routing: candidate offers no evidence for the stated attribute, keeping the database fallback",
        )
        continue
      }

      logger.info(
        {
          foodName: query.foodName, chosen: provider.name, chosenRecord: match.productName,
          insteadOf: shortfall.fallbackStatus, insteadOfRecord: shortfall.match.productName,
          satisfied: shortfall.match.unmetAttributes,
        },
        "Attribute-aware routing: a later provider satisfies the stated nutritional attribute",
      )
      return resolved
    }

    if (!shortfall) {
      logger.info(
        { foodName: query.foodName, provider: provider.name, record: match.productName, unmet: match.unmetAttributes },
        "Attribute shortfall: keeping this as a fallback and continuing the chain",
      )
      shortfall = resolved
    }
  }

  // Nothing satisfied the claim. The best identity match still beats no answer at all, and it
  // carries its unmetAttributes into provenance and match quality so the gap is visible.
  if (shortfall) {
    logger.info(
      { foodName: query.foodName, provider: shortfall.fallbackStatus, record: shortfall.match.productName, unmet: shortfall.match.unmetAttributes },
      "Attribute-aware routing: no provider satisfied the stated attribute, using the best identity match",
    )
  }
  return shortfall
}
