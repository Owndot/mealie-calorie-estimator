import { logger } from "../../utils/logger.js"
import { sanityCheckNutrients } from "../sanity-check.js"
import { findOverride, overridesReady, type FoodOverride } from "../food-overrides.js"
import { loadBlsRecordByCode } from "./bls-provider.js"
import { loadUsdaRecordById } from "./usda-local-provider.js"
import { loadOffProductByBarcode } from "./off-provider.js"
import { UNKNOWN_ATTRIBUTES, type ProviderMatch } from "../../types.js"
import type { NutrientProvider, ProviderQuery } from "./types.js"

/**
 * Serves a record a PERSON chose for this ingredient.
 *
 * It sits after the user's own Mealie recipes and before every automatic provider: an override
 * exists to settle what automatic resolution could not, and a Mealie recipe is not automatic
 * resolution — it is the user's own data, computed from their own ingredients, and it updates
 * itself when they edit it. An override is a static pointer, so letting it shadow a live recipe
 * would make editing that recipe silently ineffective.
 *
 * The override is a POINTER. The nutrients come from the target record, reloaded through the same
 * data the ordinary providers use, every single time. Nothing stored here can become a nutrient
 * value, and a target that cannot be loaded produces NO match at all — the chain simply continues,
 * which returns the ingredient to exactly the behaviour it had before anyone bound it.
 */

const PROVIDER_NAME = "food-override"

/**
 * High, but not certain. A person chose this deliberately, which outranks any automatic match —
 * while stopping short of 1.0, because the binding can age: a product is reformulated, a database
 * is re-imported, and nothing re-asks the person.
 */
const OVERRIDE_CONFIDENCE = 0.95

export interface OverrideTarget {
  name: string
  nutrients: ProviderMatch["nutrients"]
  brand: string | null
  dataType: string | null
  foodType: ProviderMatch["foodType"]
}

/**
 * Reloads the record an override points at. Exported so the management API can report a target's
 * live status without going through a resolution.
 */
export async function loadOverrideTarget(override: FoodOverride): Promise<OverrideTarget | null> {
  try {
    switch (override.provider) {
      case "bls": {
        const r = await loadBlsRecordByCode(override.providerId)
        return r && { name: r.name, nutrients: r.nutrients, brand: null, dataType: null, foodType: r.foodType }
      }
      case "usda-local": {
        const r = await loadUsdaRecordById(override.providerId)
        return r && { name: r.name, nutrients: r.nutrients, brand: null, dataType: r.dataType, foodType: r.foodType }
      }
      case "off": {
        const r = await loadOffProductByBarcode(override.providerId)
        return r && { name: r.name, nutrients: r.nutrients, brand: r.brand, dataType: "OFF product", foodType: r.foodType }
      }
      default:
        // A provider this build does not know how to reload. Refusing is the only safe answer:
        // the alternative is inventing what the person meant.
        return null
    }
  } catch (err) {
    logger.warn({ err, provider: override.provider, providerId: override.providerId }, "Food override target reload threw")
    return null
  }
}

export class OverrideProvider implements NutrientProvider {
  readonly name = PROVIDER_NAME

  async lookup(query: ProviderQuery): Promise<ProviderMatch | null> {
    if (!overridesReady()) return null

    const override = findOverride({
      canonicalEnglish: query.foodName,
      state: query.state,
      attributes: query.attributes ?? UNKNOWN_ATTRIBUTES,
      // Already evidence-verified upstream: a brand survives only when the structured ingredient
      // text actually named it, which is precisely "the ingredient explicitly has a brand".
      brand: query.brand,
    })
    if (!override) return null

    const target = await loadOverrideTarget(override)
    if (!target) {
      // Loudly, and then out of the way. The ingredient falls back to ordinary resolution rather
      // than receiving something stale wearing the override's name.
      logger.warn(
        { overrideId: override.id, overrideKey: override.overrideKey, provider: override.provider, providerId: override.providerId, foodName: query.foodName },
        "Food override target could not be loaded — falling back to the normal resolver",
      )
      return null
    }

    // The same plausibility check every other provider's answer passes. A target that has become
    // nonsense is a broken target, not a licence to serve nonsense.
    const check = sanityCheckNutrients(target.nutrients, query.foodName)
    if (!check.ok) {
      logger.warn(
        { overrideId: override.id, provider: override.provider, providerId: override.providerId, reason: check.reason },
        "Food override target failed the sanity check — falling back to the normal resolver",
      )
      return null
    }

    logger.info(
      { overrideId: override.id, foodName: query.foodName, provider: override.provider, providerId: override.providerId, record: target.name },
      "Resolved by a user-confirmed food override",
    )

    return {
      nutrients: target.nutrients,
      canonicalName: query.foodName,
      // The REAL provider and id stay visible; the override is recorded as the reason, not as the
      // source. Provenance must never hide which database the numbers actually came from.
      brand: target.brand ?? query.brand,
      state: query.state,
      provider: override.provider,
      providerId: override.providerId,
      productName: target.name,
      confidence: OVERRIDE_CONFIDENCE,
      dataType: target.dataType,
      foodType: target.foodType,
      matchReason: "user-confirmed-override",
    }
  }
}

export const overrideProvider = new OverrideProvider()
