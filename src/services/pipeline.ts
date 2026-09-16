import { getRecipe, getRecipeHouseholdId, patchRecipe } from "./mealie-client.js"
import { computeIngredientHash, isManuallyOwned, hasManuallyModifiedNutrition, buildManualAckPatch, shouldEstimate } from "./estimator.js"
import { perServingFromRecipeNutrition, tagsAreComplete, resolveAndMergeTags, estimateAndTag } from "./tagging.js"
import { logger } from "../utils/logger.js"
import { sourceFingerprint } from "./providers/mealie-recipe-provider.js"
import type { Completeness, MealieRecipe } from "../types.js"

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
/**
 * True when any of the user's own recipes this one draws nutrition from has changed since the last
 * estimate — see the mealie-recipe provider. Compares the recorded fingerprint against the source's
 * current nutrition/servings/yield state.
 *
 * Checked at the DEPENDENT's next run rather than cascaded from the source, which keeps the update
 * path a simple check and makes a webhook storm structurally impossible: nothing here writes to any
 * recipe other than the one being processed.
 */
async function recipeSourcesChanged(recipe: MealieRecipe, householdId: string | null): Promise<boolean> {
  const raw = recipe.extras?.calorie_estimator_recipe_sources
  if (!raw) return false

  let recorded: Record<string, string>
  try {
    recorded = JSON.parse(raw) as Record<string, string>
  } catch {
    return false
  }

  for (const [slug, fingerprint] of Object.entries(recorded)) {
    if (slug === recipe.slug) continue // cannot depend on itself; ignore rather than loop
    try {
      const source = await getRecipe(slug, householdId)
      if (sourceFingerprint(source) !== fingerprint) return true
    } catch {
      // A source that cannot be read (deleted, permissions) is not evidence of a change; the
      // existing estimate stands until something else prompts a re-run.
      continue
    }
  }
  return false
}

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
  // scenarios are protected: a recipe already flagged manually-owned (whether never estimated,
  // or acknowledged as manual on a prior run — see isManuallyOwned), and nutrition the estimator
  // DID write and still owns but whose fingerprint no longer matches — i.e. a person edited it
  // by hand after the last estimate, without ever going through the manual-ack path.
  const manuallyOwned = isManuallyOwned(recipe)
  const modifiedAfterEstimate = !manuallyOwned && hasManuallyModifiedNutrition(recipe)

  if ((manuallyOwned || modifiedAfterEstimate) && !opts.overrideManual) {
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
