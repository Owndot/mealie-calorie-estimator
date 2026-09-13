import { validateProfile } from "./nutrition-validation.js"
import { config } from "../config.js"
import { logger } from "../utils/logger.js"
import { getCachedLlmEstimate, setCachedLlmEstimate, getCachedLlmNutrients, setCachedLlmNutrients } from "../utils/cache.js"
import { waitForRateLimit, RateLimitType } from "../utils/rate-limiter.js"
import type { NutrientSet } from "../types.js"

export async function estimateGrams(quantity: number, unitName: string, foodName: string): Promise<number | null> {
  if (!config.llm.enabled) return null
  if (!config.llm.apiKey) {
    logger.warn("LLM enabled but LLM_API_KEY is not set")
    return null
  }

  const cached = getCachedLlmEstimate(`weight-v3:${unitName}`, foodName)
  if (cached !== undefined) {
    const totalGrams = cached * quantity
    logger.debug({ unitName, foodName, gramsPerUnit: cached, totalGrams }, "LLM estimate cache hit")
    return totalGrams
  }

  const prompt = `Estimate the weight in grams for 1 ${unitName} of ${foodName}. Consider typical packaging sizes and food densities. Return ONLY a single number (the weight in grams). No explanation, no unit, no punctuation. If you cannot estimate, return 0.`

  try {
    await waitForRateLimit(RateLimitType.Llm)

    const res = await fetch(`${config.llm.baseUrl}${config.llm.endpointUrl}`, {
      method: "POST",
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

    if (!Number.isFinite(num) || num <= 0 || num > 10000) {
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

export async function estimateNutrients(foodName: string): Promise<NutrientSet | null> {
  if (!config.llm.enabled || !config.llm.apiKey) return null

  const cached = getCachedLlmNutrients(`nutrition-v3:llm:${foodName}`)
  if (cached) {
    logger.debug({ foodName }, "LLM nutrient cache hit")
    return cached
  }

  const prompt = `Estimate nutrition for 100 g of the edible ingredient: ${JSON.stringify(foodName)}. Respect dry/raw, cooked, canned, drained, frozen and fresh state explicitly specified; do not substitute cooked values for dry staples. Use typical edible-form values, not serving values. Return ONLY a valid JSON object with keys kcal, protein, carbs, fat, saturatedFat, transFat, fiber, sugar, sodium, cholesterol. Units: kcal = kcal per 100 g; protein, carbs, fat, saturatedFat, transFat, fiber, sugar = grams per 100 g; sodium and cholesterol = milligrams (mg) per 100 g. Carbs means available carbohydrate excluding fiber. Each value must be a finite non-negative JSON number, or null if unknown. Return JSON null if the food/state is ambiguous or confidence is low. Do not invent values. No markdown or explanation.`

  try {
    await waitForRateLimit(RateLimitType.Llm)

    const res = await fetch(`${config.llm.baseUrl}${config.llm.endpointUrl}`, {
      method: "POST",
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

    if (validateProfile(nutrients).length === 0) {
      setCachedLlmNutrients(`nutrition-v3:llm:${foodName}`, nutrients)
      logger.debug({ foodName, kcal: nutrients.kcalPer100g }, "LLM nutrient estimate obtained")
      return nutrients
    }

    logger.debug({ foodName, content }, "LLM returned missing or invalid kcal, discarding")
    return null
  } catch (err) {
    logger.warn({ err, foodName }, "LLM nutrient estimation failed")
    return null
  }
}
