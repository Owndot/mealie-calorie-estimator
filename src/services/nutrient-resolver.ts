import { getProviderChain } from "./providers/registry.js"
import { sanityCheckNutrients } from "./sanity-check.js"
import { logger } from "../utils/logger.js"
import type { ProviderQuery } from "./providers/types.js"
import type { FoodRoute, FallbackStatus, ProviderMatch } from "../types.js"

export interface ResolvedNutrients {
  match: ProviderMatch
  fallbackStatus: FallbackStatus
}

/**
 * Walks the routing-aware provider chain for one ingredient. Rejects any candidate that fails
 * the sanity check and tries the next provider rather than accepting it, per the skill's
 * "reject candidate -> try another provider -> log reason" rule.
 */
export async function resolveNutrients(query: ProviderQuery, route: FoodRoute): Promise<ResolvedNutrients | null> {
  const chain = getProviderChain(route)

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

    return { match, fallbackStatus: provider.name as FallbackStatus }
  }

  return null
}
