import { config } from "../config.js"
import { logger } from "../utils/logger.js"
import { getCachedLlmEstimate, setCachedLlmEstimate, getCachedLlmNutrients, setCachedLlmNutrients } from "../utils/cache.js"
import { waitForRateLimit, RateLimitType } from "../utils/rate-limiter.js"
import type { NutrientSet } from "../types.js"

/**
 * Parses a possibly-untyped JSON value to a number, preserving a genuine 0 (e.g. salt/water are
 * legitimately 0 kcal) rather than collapsing it to null. `Number(x) || null` — the previous
 * implementation — is the classic JS falsy-zero footgun: it silently turned every real zero
 * value into "unknown", which then caused the caller to discard the whole estimate as if the
 * LLM had failed, even when it had answered correctly.
 */
function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * Volume units, and how many millilitres one of them is. These are the only units whose LLM answer
 * can be validated physically: grams-per-millilitre is a DENSITY, and every edible substance sits
 * in a narrow, food-independent band. Piece/package units deliberately get no such treatment —
 * see CATASTROPHIC_DENSITY_* below.
 */
const VOLUME_UNIT_ML: Record<string, number> = {
  ml: 1, milliliter: 1, milliliters: 1, millilitre: 1, millilitres: 1,
  l: 1000, liter: 1000, liters: 1000, litre: 1000, litres: 1000,
}

/**
 * A deliberately BROAD catastrophic-error guard, not a density classifier. Its only job is to
 * reject order-of-magnitude nonsense such as the 100 g/ml that turned 750 ml of Gemuesebruehe into
 * 75 kg. Real edible densities run from roughly 0.1 g/ml (aerated/puffed) to 1.5 g/ml (honey,
 * syrup); these bounds leave ~20x headroom on both sides so no legitimate food is ever rejected.
 *
 * There is deliberately NO equivalent bound for Stueck/Bund/Dose/Glas/Packung: one "Stueck" spans
 * a caper (~0.1 g) to a whole turkey (~10 kg) and one "Dose" spans 70 g of tomato paste to a 5 kg
 * catering tin, so any universal ceiling would reject legitimate foods. Those units keep only the
 * existing finite/positive check, and remain a documented gap.
 */
const CATASTROPHIC_DENSITY_MIN_G_PER_ML = 0.05
const CATASTROPHIC_DENSITY_MAX_G_PER_ML = 5.0

/** The reference volume we ask about. The live failure was a per-100-ml answer to a per-1-ml
 * question, so we now ask at the scale the model naturally answers and divide back down. */
const DENSITY_REFERENCE_ML = 100

function volumeUnitMl(unitName: string): number | null {
  return VOLUME_UNIT_ML[unitName.toLowerCase().trim()] ?? null
}

/**
 * Volume estimates are cached as a food-specific DENSITY under one shared key, so millilitres and
 * litres of the same food can never disagree (previously "Liter"/"Milliliter" were separate
 * entries holding values on different scales).
 */
function densityCacheUnitKey(): string {
  return "__density_g_per_ml"
}

export async function estimateGrams(quantity: number, unitName: string, foodName: string): Promise<number | null> {
  if (!config.llm.enabled) return null
  if (!config.llm.apiKey) {
    logger.warn("LLM enabled but LLM_API_KEY is not set")
    return null
  }

  const mlPerUnit = volumeUnitMl(unitName)
  const cacheUnitKey = mlPerUnit !== null ? densityCacheUnitKey() : unitName

  const cached = getCachedLlmEstimate(cacheUnitKey, foodName)
  if (cached !== undefined) {
    const totalGrams = mlPerUnit !== null ? cached * mlPerUnit * quantity : cached * quantity
    logger.debug(
      mlPerUnit !== null
        ? { unitName, foodName, gramsPerMl: cached, totalGrams }
        : { unitName, foodName, gramsPerUnit: cached, totalGrams },
      "LLM estimate cache hit",
    )
    return totalGrams
  }

  const prompt = mlPerUnit !== null
    ? `Estimate the weight in grams of ${DENSITY_REFERENCE_ML} ml of ${foodName}. Consider the food's density (${DENSITY_REFERENCE_ML} ml of water is 100 g; of oil about 91 g). Return ONLY a single number (the weight in grams for ${DENSITY_REFERENCE_ML} ml). No explanation, no unit, no punctuation. If you cannot estimate, return 0.`
    : `Estimate the weight in grams for 1 ${unitName} of ${foodName}. Consider typical packaging sizes and food densities. Return ONLY a single number (the weight in grams). No explanation, no unit, no punctuation. If you cannot estimate, return 0.`

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
    const num = parseInt(trimmed, 10)

    if (isNaN(num) || num <= 0) {
      logger.warn({ unitName, foodName, llmResponse: trimmed }, "LLM returned invalid number")
      return null
    }

    if (mlPerUnit !== null) {
      // Normalize to a density BEFORE any multiplication, and validate it there. The live failure
      // multiplied an unvalidated 100 g/ml by 750 ml and wrote it to the cache, so the 75 kg then
      // came back on every later run without another LLM call.
      const gramsPerMl = num / DENSITY_REFERENCE_ML
      if (gramsPerMl < CATASTROPHIC_DENSITY_MIN_G_PER_ML || gramsPerMl > CATASTROPHIC_DENSITY_MAX_G_PER_ML) {
        logger.warn(
          { unitName, foodName, gramsPerMl, referenceMl: DENSITY_REFERENCE_ML, llmGrams: num,
            allowed: `${CATASTROPHIC_DENSITY_MIN_G_PER_ML}-${CATASTROPHIC_DENSITY_MAX_G_PER_ML} g/ml` },
          "LLM density estimate is physically impossible — rejected, not cached",
        )
        return null
      }
      const totalGrams = gramsPerMl * mlPerUnit * quantity
      setCachedLlmEstimate(cacheUnitKey, foodName, gramsPerMl)
      logger.debug({ unitName, foodName, gramsPerMl, totalGrams }, "LLM estimate obtained")
      return totalGrams
    }

    const gramsPerUnit = num
    const totalGrams = gramsPerUnit * quantity

    setCachedLlmEstimate(cacheUnitKey, foodName, gramsPerUnit)
    logger.debug({ unitName, foodName, gramsPerUnit, totalGrams }, "LLM estimate obtained")

    return totalGrams
  } catch (err) {
    logger.warn({ err, unitName, foodName }, "LLM estimation failed")
    return null
  }
}

export async function estimateNutrients(foodName: string): Promise<NutrientSet | null> {
  if (!config.llm.enabled || !config.llm.apiKey) return null

  const cached = getCachedLlmNutrients(foodName)
  if (cached) {
    logger.debug({ foodName }, "LLM nutrient cache hit")
    return cached
  }

  const prompt = `Estimate nutritional values per 100g for "${foodName}". Return ONLY valid JSON with these keys: {"kcal":0,"protein":0,"carbs":0,"fat":0,"saturatedFat":0,"transFat":0,"fiber":0,"sugar":0,"sodium":0,"cholesterol":0}. ALL values must be numbers in GRAMS per 100g (kcal excepted, which is in kilocalories) — including sodium and cholesterol, which must be grams, NOT milligrams (e.g. table salt is sodium≈38, a food with 500mg sodium is sodium=0.5). Use typical values for the food. No explanation, no markdown.`

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

    const json = JSON.parse(content.replace(/```json\n?|\n?```/g, ""))

    const nutrients: NutrientSet = {
      kcalPer100g: numOrNull(json.kcal),
      proteinPer100g: numOrNull(json.protein),
      carbsPer100g: numOrNull(json.carbs),
      fatPer100g: numOrNull(json.fat),
      saturatedFatPer100g: numOrNull(json.saturatedFat),
      transFatPer100g: numOrNull(json.transFat),
      unsaturatedFatPer100g: null,
      fiberPer100g: numOrNull(json.fiber),
      sugarPer100g: numOrNull(json.sugar),
      sodiumPer100g: numOrNull(json.sodium),
      cholesterolPer100g: numOrNull(json.cholesterol),
    }

    if (nutrients.fatPer100g !== null) {
      const s = nutrients.saturatedFatPer100g ?? 0
      const t = nutrients.transFatPer100g ?? 0
      nutrients.unsaturatedFatPer100g = Math.round((nutrients.fatPer100g - s - t) * 10) / 10
    }

    // A genuine 0 (salt, water, pure spices) is a valid kcal value, not a failure signal — only
    // a missing/unparseable kcal (numOrNull returning null) means the LLM didn't give us a
    // usable estimate. Unknown must never be silently treated the same as zero, and the reverse
    // (zero silently discarded as "unknown") is just as wrong.
    if (nutrients.kcalPer100g !== null) {
      setCachedLlmNutrients(foodName, nutrients)
      logger.debug({ foodName, kcal: nutrients.kcalPer100g }, "LLM nutrient estimate obtained")
      return nutrients
    }

    logger.debug({ foodName, content }, "LLM returned no usable kcal value, discarding")
    return null
  } catch (err) {
    logger.warn({ err, foodName }, "LLM nutrient estimation failed")
    return null
  }
}
