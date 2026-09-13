import { contextForName, nutrientCacheKey, type IngredientContext } from "./ingredient-context.js"
import { convertToGrams, normalizeUnitName } from "./unit-converter.js"
import { energyConsistencyErrors, validateProfile } from "./nutrition-validation.js"
import { config } from "../config.js"
import { logger } from "../utils/logger.js"
import { getCachedLlmEstimate, setCachedLlmEstimate, getCachedLlmNutrients, setCachedLlmNutrients } from "../utils/cache.js"
import { waitForRateLimit, RateLimitType } from "../utils/rate-limiter.js"
import type { NutrientSet } from "../types.js"

export async function estimateGrams(quantity: number, unitName: string, foodName: string): Promise<number | null> {
  unitName = normalizeUnitName(unitName)
  const context = contextForName(foodName)
  if (context.state === "ambiguous" || !Number.isFinite(quantity) || quantity <= 0) return null
  const deterministic = convertToGrams(quantity, { id: "", name: unitName, abbreviation: null, pluralName: null, standardUnit: null, standardQuantity: null }, context)
  if (deterministic !== null) return deterministic
  foodName = context.query
  if (!config.llm.enabled) return null
  if (!config.llm.apiKey) {
    logger.warn("LLM enabled but LLM_API_KEY is not set")
    return null
  }

  const maxGrams = unitName === "teaspoon" ? 15 : unitName === "tablespoon" ? 45 : unitName === "pinch" ? 0.5 : 10000
  const cached = getCachedLlmEstimate(`weight-v3:${unitName}`, foodName)
  if (cached !== undefined && Number.isFinite(cached) && cached > 0 && cached <= maxGrams) {
    const totalGrams = cached * quantity
    logger.debug({ unitName, foodName, gramsPerUnit: cached, totalGrams }, "LLM estimate cache hit")
    return totalGrams
  }

  const prompt = `Estimate the weight in grams for 1 ${unitName} of ${foodName}. Consider typical packaging sizes and food densities. Return ONLY a single number (the weight in grams). Decimal numbers are allowed. No explanation or unit. If you cannot estimate, return 0.`

  try {
    await waitForRateLimit(RateLimitType.Llm)

    const res = await fetch(`${config.llm.baseUrl}${config.llm.endpointUrl}`, {
      method: "POST",
      signal: AbortSignal.timeout(60000),
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.llm.apiKey}`,
      },
      body: JSON.stringify({
        model: config.llm.model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.1,
        max_tokens: 10,
      }),
    })

    if (!res.ok) {
      logger.warn({ status: res.status, unitName, foodName }, "LLM API returned error")
      return null
    }

    const data: any = await res.json()
    const content = data?.choices?.[0]?.message?.content

    if (content == null) {
      logger.warn({ unitName, foodName }, "LLM returned empty response")
      return null
    }

    const trimmed = content.trim()
    const num = Number(trimmed)

    if (!Number.isFinite(num) || num <= 0 || num > maxGrams) {
      logger.warn({ unitName, foodName, llmResponse: trimmed }, "LLM returned invalid number")
      return null
    }

    const gramsPerUnit = num
    const totalGrams = gramsPerUnit * quantity

    setCachedLlmEstimate(`weight-v3:${unitName}`, foodName, gramsPerUnit)
    logger.debug({ unitName, foodName, gramsPerUnit, totalGrams }, "LLM estimate obtained")

    return totalGrams
  } catch (err) {
    logger.warn({ err, unitName, foodName }, "LLM estimation failed")
    return null
  }
}

function nutrientNumber(value: unknown): number | null {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return null
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : null
}

export async function estimateNutrients(foodName: string, suppliedContext?: IngredientContext, allowRetry = true): Promise<NutrientSet | null> {
  if (!config.llm.enabled || !config.llm.apiKey) return null

  const context = suppliedContext ?? contextForName(foodName)
  if (context.state === "ambiguous") return null
  const cacheKey = nutrientCacheKey("llm", context)
  foodName = context.query
  const cached = getCachedLlmNutrients(cacheKey)
  if (cached && validateProfile(cached).length === 0) {
    logger.debug({ foodName }, "LLM nutrient cache hit")
    return cached
  }

  const fatConstraint = context.fatPercentage != null ? ` The ingredient explicitly states ${context.fatPercentage}% fat; returned fat must be close to ${context.fatPercentage} g per 100 g (allowing normal label rounding).` : ""
  const prompt = `Estimate nutrition for 100 g of the edible ingredient: ${JSON.stringify(foodName)}.${fatConstraint}${allowRetry ? "" : " Correct the previous estimate: ensure kcal is consistent with protein*4 + available carbs*4 + fat*9, with fiber contributing approximately 2 kcal/g, and keep all values mutually plausible."} Respect dry/raw, cooked, canned, drained, frozen and fresh state explicitly specified; do not substitute cooked values for dry staples. Use typical edible-form values, not serving values. Return ONLY a valid JSON object with keys kcal, protein, carbs, fat, saturatedFat, transFat, fiber, sugar, sodium, cholesterol. Units: kcal = kcal per 100 g; protein, carbs, fat, saturatedFat, transFat, fiber, sugar = grams per 100 g; sodium and cholesterol = milligrams (mg) per 100 g. Carbs means available carbohydrate excluding fiber. Each value must be a finite non-negative JSON number, or null if unknown. Return JSON null if the food/state is ambiguous or confidence is low. Do not invent values. No markdown or explanation.`

  try {
    await waitForRateLimit(RateLimitType.Llm)

    const res = await fetch(`${config.llm.baseUrl}${config.llm.endpointUrl}`, {
      method: "POST",
      signal: AbortSignal.timeout(60000),
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.llm.apiKey}`,
      },
      body: JSON.stringify({
        model: config.llm.model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.1,
        max_tokens: 200,
      }),
    })

    if (!res.ok) {
      logger.warn({ status: res.status, foodName }, "LLM nutrient API returned error")
      return null
    }

    const data: any = await res.json()
    const content = data?.choices?.[0]?.message?.content?.trim()

    if (!content) {
      logger.warn({ foodName }, "LLM nutrient returned empty response")
      return null
    }

    const json: unknown = JSON.parse(content)
    if (json === null || typeof json !== "object" || Array.isArray(json)) return null
    const fields = json as Record<string, unknown>
    const keys = ["kcal", "protein", "carbs", "fat", "saturatedFat", "transFat", "fiber", "sugar", "sodium", "cholesterol"]
    if (keys.some(key => fields[key] != null && (typeof fields[key] !== "number" || !Number.isFinite(fields[key]) || (fields[key] as number) < 0))) return null

    const nutrients: NutrientSet = {
      kcalPer100g: nutrientNumber(fields.kcal),
      proteinPer100g: nutrientNumber(fields.protein),
      carbsPer100g: nutrientNumber(fields.carbs),
      fatPer100g: nutrientNumber(fields.fat),
      saturatedFatPer100g: nutrientNumber(fields.saturatedFat),
      transFatPer100g: nutrientNumber(fields.transFat),
      unsaturatedFatPer100g: null,
      fiberPer100g: nutrientNumber(fields.fiber),
      sugarPer100g: nutrientNumber(fields.sugar),
      sodiumPer100g: nutrientNumber(fields.sodium),
      cholesterolPer100g: nutrientNumber(fields.cholesterol),
    }

    if (nutrients.fatPer100g !== null) {
      const s = nutrients.saturatedFatPer100g ?? 0
      const t = nutrients.transFatPer100g ?? 0
      nutrients.unsaturatedFatPer100g = Math.round((nutrients.fatPer100g - s - t) * 10) / 10
    }

    let validationErrors = validateProfile(nutrients)
    validationErrors.push(...energyConsistencyErrors(nutrients, true).filter(error => !validationErrors.includes(error)))
    if (context.fatPercentage != null && nutrients.fatPer100g != null
      && Math.abs(nutrients.fatPer100g - context.fatPercentage) > Math.max(1.5, context.fatPercentage * 0.25)) {
      validationErrors.push("fat percentage disagrees with explicit descriptor")
    }
    const macroOnlyErrors = validationErrors.filter(error => error !== "energy disagrees with macros")
    if (macroOnlyErrors.length === 0 && validationErrors.includes("energy disagrees with macros")) {
      nutrients.kcalPer100g = Math.round((
        (nutrients.proteinPer100g ?? 0) * 4
        + (nutrients.carbsPer100g ?? 0) * 4
        + (nutrients.fatPer100g ?? 0) * 9
        + (nutrients.fiberPer100g ?? 0) * 2
      ) * 10) / 10
      validationErrors = validateProfile(nutrients)
    }
    if (validationErrors.length === 0) {
      setCachedLlmNutrients(cacheKey, nutrients)
      logger.debug({ foodName, kcal: nutrients.kcalPer100g }, "LLM nutrient estimate obtained")
      return nutrients
    }

    const retryableEnergyIssue = validationErrors.includes("energy disagrees with macros")
      || validationErrors.includes("fat percentage disagrees with explicit descriptor")
    if (allowRetry && retryableEnergyIssue) {
      logger.debug({ foodName, validationErrors }, "Retrying rejected LLM nutrient profile once")
      return estimateNutrients(foodName, context, false)
    }
    logger.warn({ foodName, validationErrors }, "Rejecting implausible LLM nutrient profile")
    return null
  } catch (err) {
    logger.warn({ err, foodName }, "LLM nutrient estimation failed")
    return null
  }
}
