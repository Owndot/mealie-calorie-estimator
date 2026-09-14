import type { NutrientSet, MealieTag, MealieRecipe, EstimateResult } from "../types.js"
import { getOrCreateTags, patchRecipe } from "./mealie-client.js"
import { estimateRecipe, buildNutritionPatch } from "./estimator.js"
import { perServingFromRecipeNutrition } from "./nutrition-format.js"

export { perServingFromRecipeNutrition }

export function getCalorieTag(kcal: number | null): string | null {
  if (kcal === null) return null
  if (kcal < 350) return "Calories:Light"
  if (kcal <= 600) return "Calories:Moderate"
  if (kcal <= 850) return "Calories:Hearty"
  return "Calories:Heavy"
}

export function getDigestibilityTag(nutrients: NutrientSet): string {
  const { kcalPer100g, fatPer100g } = nutrients

  if (kcalPer100g === null || fatPer100g === null) return "Digest:Unknown"

  const fatCalPct = (fatPer100g * 9 / kcalPer100g) * 100

  if (fatCalPct < 30 && kcalPer100g <= 600) return "Digest:Easy"
  if (fatCalPct >= 40) return "Digest:Slow"

  return "Digest:Moderate"
}

export function computeTags(perServing: NutrientSet): string[] {
  const tags: string[] = []
  const calorieTag = getCalorieTag(perServing.kcalPer100g)
  if (calorieTag) tags.push(calorieTag)
  tags.push(getDigestibilityTag(perServing))
  return tags
}

export async function resolveAutoTags(
  recipe: MealieRecipe,
  perServing: NutrientSet,
  householdId?: string | null,
): Promise<{ tags: MealieTag[]; slugs: string[] }> {
  const tagNames = computeTags(perServing)
  const autoTags = await getOrCreateTags(tagNames, householdId)
  const oldSlugs: string[] = JSON.parse(recipe.extras?.calorie_estimator_tags || "[]")
  return { tags: autoTags, slugs: oldSlugs }
}

export function mergeTags(
  recipe: MealieRecipe,
  autoTags: MealieTag[],
  oldSlugs: string[],
): MealieTag[] {
  const userTags = (recipe.tags || []).filter(t => !oldSlugs.includes(t.slug))
  return [...userTags, ...autoTags]
}

export function tagsAreComplete(recipe: MealieRecipe): boolean {
  const slugs: string[] = JSON.parse(recipe.extras?.calorie_estimator_tags || "[]")
  if (slugs.length === 0) return false
  const current = new Set((recipe.tags || []).map(t => t.slug))
  return slugs.every(s => current.has(s))
}

export async function resolveAndMergeTags(
  recipe: MealieRecipe,
  perServing: NutrientSet,
  householdId?: string | null,
): Promise<{ tags: MealieTag[]; tagSlugs: string[] }> {
  const { tags: autoTags, slugs: oldSlugs } = await resolveAutoTags(recipe, perServing, householdId)
  const merged = mergeTags(recipe, autoTags, oldSlugs)
  return { tags: merged, tagSlugs: autoTags.map(t => t.slug) }
}

export async function estimateAndTag(
  recipe: MealieRecipe,
  hash: string,
  householdId?: string | null,
): Promise<{ calories: number | null; tagSlugs: string[]; completeness: EstimateResult["completeness"] }> {
  const result = await estimateRecipe(recipe)
  const nutritionPatch = buildNutritionPatch(result, hash, recipe.recipeYield)
  const { tags, tagSlugs } = await resolveAndMergeTags(recipe, result.perServingNutrients, householdId)
  await patchRecipe(recipe.slug, {
    ...nutritionPatch,
    tags,
    extras: { ...nutritionPatch.extras, calorie_estimator_tags: JSON.stringify(tagSlugs) },
  }, householdId)
  return { calories: result.perServingNutrients.kcalPer100g, tagSlugs, completeness: result.completeness }
}
