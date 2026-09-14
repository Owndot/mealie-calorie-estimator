import { getRecipe, getRecipeHouseholdId, patchRecipe } from "./mealie-client.js"
import { computeIngredientHash, hasManualCalories, hasManuallyModifiedNutrition, buildManualAckPatch, shouldEstimate } from "./estimator.js"
import { perServingFromRecipeNutrition, tagsAreComplete, resolveAndMergeTags, estimateAndTag } from "./tagging.js"
import { logger } from "../utils/logger.js"
import type { Completeness } from "../types.js"

export interface PipelineOptions {
  /** Bypass the ingredient-hash-unchanged skip and re-estimate. Never bypasses manual protection by itself. */
  force?: boolean
  /**
   * Explicit, separate confirmation to overwrite genuinely manual nutrition. Distinct from
   * `force` on purpose — force alone must never overwrite a manual entry.
   */
  overrideManual?: boolean
}

export type PipelineOutcome =
  | { status: "skipped-not-tagged" }
  | { status: "no-op" }
  | { status: "tags-updated"; tagSlugs: string[] }
  | { status: "manual-preserved" }
  | { status: "estimated"; calories: number | null; tagSlugs: string[]; completeness: Completeness }

/**
 * The single orchestration path shared by the webhook, on-demand estimate, and backfill
 * entry points, so loop prevention / manual protection / force semantics are enforced
 * identically everywhere instead of being reimplemented per route.
 */
export async function runEstimationPipeline(slug: string, opts: PipelineOptions = {}): Promise<PipelineOutcome> {
  const recipe = await getRecipe(slug)

  if (!shouldEstimate(recipe)) {
    logger.info({ slug }, "Recipe skipped (not tagged for estimation)")
    return { status: "skipped-not-tagged" }
  }

  const householdId = getRecipeHouseholdId(recipe)
  const hash = computeIngredientHash(recipe)
  const existingHash = recipe.extras?.calorie_estimator_hash
  const hashUnchanged = existingHash === hash

  if (hashUnchanged && !opts.force) {
    if (tagsAreComplete(recipe)) {
      logger.info({ slug }, "Tags up to date, skipping")
      return { status: "no-op" }
    }

    const perServing = perServingFromRecipeNutrition(recipe.nutrition)
    const { tags, tagSlugs } = await resolveAndMergeTags(recipe, perServing, householdId)
    await patchRecipe(slug, {
      tags,
      extras: { ...recipe.extras, calorie_estimator_tags: JSON.stringify(tagSlugs) },
    }, householdId)
    logger.info({ slug, tags: tagSlugs }, "Added missing auto-tags")
    return { status: "tags-updated", tagSlugs }
  }

  // Re-estimation is about to happen, either because ingredients changed or force was
  // requested. Manual protection applies either way — force alone never overwrites a
  // genuinely manual entry; only the separate overrideManual flag can. Two distinct manual
  // scenarios are protected: nutrition that was never touched by the estimator at all, and
  // nutrition the estimator DID write before but whose fingerprint no longer matches — i.e. a
  // person edited it by hand after the last estimate.
  const neverEstimated = hasManualCalories(recipe)
  const modifiedAfterEstimate = !neverEstimated && hasManuallyModifiedNutrition(recipe)

  if ((neverEstimated || modifiedAfterEstimate) && !opts.overrideManual) {
    const reason = modifiedAfterEstimate ? "modified-after-estimate" : "never-estimated"
    logger.info({ slug, calories: recipe.nutrition?.calories, reason }, "Manual nutrition detected, acknowledging without overwriting")
    const patch = buildManualAckPatch(recipe, hash, reason)
    await patchRecipe(slug, patch, householdId)
    return { status: "manual-preserved" }
  }

  const { calories, tagSlugs, completeness } = await estimateAndTag(recipe, hash, householdId)
  logger.info({ slug, calories, tags: tagSlugs, completeness }, "Updated recipe nutrition and tags")
  return { status: "estimated", calories, tagSlugs, completeness }
}
