import crypto from "node:crypto"
import { config } from "../../config.js"
import { logger } from "../../utils/logger.js"
import { normalizeKey } from "../../utils/cache.js"
import { getRecipe, listRecipeNames } from "../mealie-client.js"
import type { NutrientSet, ProviderMatch, MealieRecipe } from "../../types.js"
import type { NutrientProvider, ProviderQuery } from "./types.js"

/**
 * The user's OWN Mealie recipes as a nutrition source for homemade ingredients.
 *
 * A recipe that is itself an ingredient — a curry paste, a spice mix, a stock — is the one food
 * the public databases can never know. Found live: Butter Chicken lists 100 g of "Tikka-Paste", the
 * user has a Tikka-Paste recipe totalling 2595 kcal over an 800 g yield (324 kcal/100 g), and the
 * pipeline was estimating it at 100 kcal/100 g from an LLM guess — a threefold understatement of
 * the single most calorie-dense thing in the dish.
 *
 * Deliberately the most conservative provider in the chain:
 *
 *   - Only an EXACT normalized-name match counts. "Tikka-Paste" finds the "Tikka-Paste" recipe;
 *     nothing merely containing "Tikka" does. Fuzzy-matching a user's whole recipe collection
 *     against every ingredient is a good way to silently attribute a curry's nutrition to a spice.
 *   - The source must state a yield IN MASS. Mealie already models this (recipeYieldQuantity +
 *     recipeYield), so no new metadata is invented; a recipe yielding "4 servings" or "1 loaf" is
 *     declined rather than guessed at, and cooked weight is NEVER inferred from ingredient weights
 *     because evaporation makes that unreliable in exactly the cases that matter (sauces, pastes).
 *   - The source must already have nutrition. This provider reads what Mealie holds; it never
 *     triggers a nested estimation, which is what keeps recursion impossible rather than merely
 *     guarded.
 *   - A recipe never resolves through itself or through an ancestor — see `ancestors`.
 */

const PROVIDER_NAME = "mealie-recipe"

/** Mass units Mealie's free-text `recipeYield` may carry, and their gram factor. */
const MASS_YIELD_UNITS: [RegExp, number][] = [
  [/^(g|gr|gramm|gram|grams)$/i, 1],
  [/^(kg|kilo|kilogramm|kilogram|kilograms)$/i, 1000],
  [/^(ml|milliliter|millilitre)$/i, 1],   // 1 ml ≈ 1 g is wrong in general but right for the
  [/^(l|liter|litre|liters|litres)$/i, 1000], // water-like sauces/stocks people actually measure this way
]

export function yieldInGrams(recipe: Pick<MealieRecipe, "recipeYield" | "recipeYieldQuantity">): number | null {
  const quantity = recipe.recipeYieldQuantity
  if (typeof quantity !== "number" || !Number.isFinite(quantity) || quantity <= 0) return null
  const unit = (recipe.recipeYield ?? "").trim()
  if (!unit) return null
  const factor = MASS_YIELD_UNITS.find(([pattern]) => pattern.test(unit))?.[1]
  if (factor === undefined) return null
  const grams = quantity * factor
  // A yield outside this range is far more likely to be a unit mix-up than a real batch.
  return grams >= 1 && grams <= 100_000 ? grams : null
}

const NUTRIENT_FIELDS: [keyof NutrientSet, string][] = [
  ["kcalPer100g", "calories"],
  ["proteinPer100g", "proteinContent"],
  ["carbsPer100g", "carbohydrateContent"],
  ["fatPer100g", "fatContent"],
  ["saturatedFatPer100g", "saturatedFatContent"],
  ["transFatPer100g", "transFatContent"],
  ["unsaturatedFatPer100g", "unsaturatedFatContent"],
  ["fiberPer100g", "fiberContent"],
  ["sugarPer100g", "sugarContent"],
  ["sodiumPer100g", "sodiumContent"],
  ["cholesterolPer100g", "cholesterolContent"],
]

/** Mealie stores sodium/cholesterol in milligrams; NutrientSet keeps grams per 100 g throughout. */
const MILLIGRAM_FIELDS = new Set<keyof NutrientSet>(["sodiumPer100g", "cholesterolPer100g"])

/**
 * Converts a source recipe into nutrients per 100 g of the finished food.
 *
 * Mealie's `nutrition` block is PER SERVING, so the whole-recipe total is that times
 * recipeServings — then divided by the mass the recipe actually yields. Returns null unless every
 * part of that chain is present and sane; there is no partial credit.
 */
export function nutrientsPer100g(recipe: MealieRecipe): { nutrients: NutrientSet; yieldGrams: number } | null {
  const yieldGrams = yieldInGrams(recipe)
  if (yieldGrams === null) return null

  const servings = recipe.recipeServings
  if (typeof servings !== "number" || !Number.isFinite(servings) || servings <= 0) return null

  const nutrition = recipe.nutrition
  if (!nutrition) return null

  const perServingKcal = Number.parseFloat(String(nutrition.calories ?? ""))
  if (!Number.isFinite(perServingKcal) || perServingKcal <= 0) return null

  const scale = (servings * 100) / yieldGrams
  const nutrients = {} as NutrientSet
  for (const [key, field] of NUTRIENT_FIELDS) {
    const raw = Number.parseFloat(String((nutrition as unknown as Record<string, unknown>)[field] ?? ""))
    if (!Number.isFinite(raw)) {
      nutrients[key] = null
      continue
    }
    const perServing = MILLIGRAM_FIELDS.has(key) ? raw / 1000 : raw
    nutrients[key] = Math.round(perServing * scale * 1000) / 1000
  }
  return { nutrients, yieldGrams }
}

/**
 * Identity of the source recipe's nutrition state. A cached dependent value must not survive the
 * source being re-estimated or re-portioned, so the fingerprint covers exactly what this provider
 * reads: the nutrition block, the servings and the yield.
 */
export function sourceFingerprint(recipe: MealieRecipe): string {
  const payload = JSON.stringify({
    nutrition: recipe.nutrition ?? null,
    servings: recipe.recipeServings ?? null,
    yieldQuantity: recipe.recipeYieldQuantity ?? null,
    yieldUnit: recipe.recipeYield ?? null,
  })
  return crypto.createHash("sha256").update(payload).digest("hex").slice(0, 16)
}

/** Recipe-name index, refreshed periodically so a newly added source recipe becomes usable. */
interface NameIndex { byName: Map<string, string>; builtAt: number; householdId: string | null }
let index: NameIndex | null = null

export function __resetRecipeIndexForTests(): void {
  index = null
}

async function getNameIndex(householdId: string | null): Promise<Map<string, string>> {
  const fresh = index
    && index.householdId === householdId
    && Date.now() - index.builtAt < config.mealieRecipeSource.indexTtlMs
  if (fresh) return index!.byName

  const byName = new Map<string, string>()
  for (const { slug, name } of await listRecipeNames(householdId)) {
    // Both spellings are indexed: a user may write the ingredient the way the recipe is titled or
    // the way its slug reads. Collisions keep the FIRST recipe rather than picking arbitrarily.
    for (const key of [normalizeKey(name), normalizeKey(slug.replace(/-/g, " "))]) {
      if (key && !byName.has(key)) byName.set(key, slug)
    }
  }
  index = { byName, builtAt: Date.now(), householdId }
  logger.info({ recipes: byName.size }, "Mealie recipe index built for homemade-ingredient matching")
  return byName
}

export class MealieRecipeProvider implements NutrientProvider {
  readonly name = PROVIDER_NAME

  async lookup(query: ProviderQuery): Promise<ProviderMatch | null> {
    if (!config.mealieRecipeSource.enabled) return null

    // Exact normalized-name match only, against the texts that actually name this ingredient.
    // canonicalEnglish is deliberately excluded: a translated name must not reach across to a
    // differently-named recipe.
    const candidates = [query.structuredName, query.canonicalGerman].filter((t): t is string => !!t?.trim())
    if (candidates.length === 0) return null

    const byName = await getNameIndex(query.householdId ?? null)
    const slug = candidates.map((t) => byName.get(normalizeKey(t))).find((s): s is string => !!s)
    if (!slug) return null

    // CYCLE PROTECTION. `ancestors` is the chain of recipes already being resolved, so a recipe
    // cannot resolve through itself (an ingredient named like its own recipe) nor through a loop
    // (A uses B, B uses A). Depth is capped as well, so even an unforeseen shape terminates.
    const ancestors = query.ancestorSlugs ?? []
    if (ancestors.includes(slug)) {
      logger.warn({ slug, ancestors }, "Mealie recipe source: dependency cycle refused")
      return null
    }
    // `ancestors` always contains the consuming recipe itself, so the nesting actually performed
    // is one less than its length: a top-level recipe resolving one source is depth 1.
    const depth = ancestors.length
    if (depth > config.mealieRecipeSource.maxDepth) {
      logger.warn({ slug, depth }, "Mealie recipe source: dependency depth limit reached")
      return null
    }

    let source: MealieRecipe
    try {
      source = await getRecipe(slug, query.householdId ?? null)
    } catch (err) {
      logger.warn({ slug, errMessage: (err as Error).message }, "Mealie recipe source: could not read the source recipe")
      return null
    }

    const derived = nutrientsPer100g(source)
    if (!derived) {
      // No nutrition, no servings, or a yield that is not a mass — all of which mean "cannot be
      // used as an ingredient", not "use it anyway".
      logger.info(
        { slug, hasNutrition: Boolean(source.nutrition), yieldQuantity: source.recipeYieldQuantity, yieldUnit: source.recipeYield },
        "Mealie recipe source: recipe found but not usable as an ingredient",
      )
      return null
    }

    logger.info(
      { ingredient: query.structuredName ?? query.foodName, slug, yieldGrams: derived.yieldGrams, kcalPer100g: derived.nutrients.kcalPer100g },
      "Mealie recipe source: resolved a homemade ingredient from the user's own recipe",
    )

    return {
      nutrients: derived.nutrients,
      canonicalName: query.foodName,
      brand: null,
      state: query.state,
      provider: PROVIDER_NAME,
      providerId: slug,
      productName: source.name,
      // High, but below an exact database match: the numbers are only as good as the source
      // recipe's own estimate, which this provider cannot vouch for.
      confidence: 0.85,
      matchReason: "exact-recipe-name",
      sourceRecipeSlug: slug,
      sourceRecipeFingerprint: sourceFingerprint(source),
      sourceRecipeYieldGrams: derived.yieldGrams,
    }
  }
}

export const mealieRecipeProvider = new MealieRecipeProvider()
