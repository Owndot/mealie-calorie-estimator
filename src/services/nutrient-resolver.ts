import { getProviderChain } from "./providers/registry.js"
import { sanityCheckNutrients } from "./sanity-check.js"
import { logger } from "../utils/logger.js"
import type { ProviderQuery } from "./providers/types.js"
import type { FoodRoute, FallbackStatus, ProviderMatch } from "../types.js"

export interface ResolvedNutrients {
  match: ProviderMatch
  fallbackStatus: FallbackStatus
}

const KNOWN_FALLBACK_STATUSES: FallbackStatus[] = ["mealie-recipe", "bls", "usda", "off", "llm-nutrient"]

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
 *      ingredient is ~35% of the recipe. Nothing in BLS or USDA is lean mince (USDA's family tops
 *      out fattier still, and BLS's lean record is Tatar, a different product), so what this buys
 *      is not a better record but the chance to ask for an estimate of the whole phrase instead.
 *   "Mayo Light" -> BLS "Salatmayonnaise", unmetAttributes ["reduced-fat"], while USDA holds an
 *      actual "Mayonnaise, light" record at 238 kcal against BLS's 490.
 *
 * In both, the system already KNEW the attribute was unmet and used the record anyway. So an
 * attribute shortfall no longer ends the search: the match is remembered and the chain continues,
 * and the first provider that satisfies the attribute wins outright. The recorded fallback is only
 * used when nothing else does.
 *
 * Food identity remains the hard requirement throughout — nothing here can promote a candidate
 * that failed the semantic gates, because such a candidate never reaches this function. This
 * chooses between records that are all already the right food.
 */
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
      if (shortfall) {
        logger.info(
          {
            foodName: query.foodName, chosen: provider.name, chosenRecord: match.productName,
            insteadOf: shortfall.fallbackStatus, insteadOfRecord: shortfall.match.productName,
            satisfied: shortfall.match.unmetAttributes,
          },
          "Attribute-aware routing: a later provider satisfies the stated nutritional attribute",
        )
      }
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
