import { getProviderChain } from "./providers/registry.js"
import { sanityCheckNutrients } from "./sanity-check.js"
import { logger } from "../utils/logger.js"
import type { ProviderQuery } from "./providers/types.js"
import type { FoodRoute, FallbackStatus, ProviderMatch } from "../types.js"

export interface ResolvedNutrients {
  match: ProviderMatch
  fallbackStatus: FallbackStatus
}

const KNOWN_FALLBACK_STATUSES: FallbackStatus[] = ["usda", "off", "llm-nutrient"]

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

    return { match, fallbackStatus: toFallbackStatus(provider.name) }
  }

  return null
}
