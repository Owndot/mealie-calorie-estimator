import type { ProviderQuery } from "../../src/services/providers/types.js"

/**
 * A type-complete ProviderQuery from whatever a test cares about.
 *
 * Tests built these as bare literals — `{ foodName, brand, category, state }` — which the type
 * never permitted; it only went unnoticed because tests sat outside the typecheck.
 *
 * Only the REQUIRED fields are filled. Every optional one is left absent rather than defaulted,
 * because a provider reads `structuredName`, `evidence`, `attributes` and `coreFood*` and behaves
 * differently when they are present: supplying them here changed eleven OFF results.
 */
export function providerQuery(partial: Partial<ProviderQuery> & { foodName: string }): ProviderQuery {
  return {
    brand: null,
    category: null,
    state: "unknown",
    foodType: "simple",
    ...partial,
  }
}
