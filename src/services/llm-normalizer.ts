import { config } from "../config.js"
import { logger } from "../utils/logger.js"
import { waitForRateLimit, RateLimitType } from "../utils/rate-limiter.js"
import type { FoodState, IngredientClassification } from "../types.js"

export interface NormalizerInput {
  index: number
  /** Structured Mealie food.name — originalText must never reach this function. */
  foodName: string
  unitName: string | null
}

const VALID_STATES: FoodState[] = ["raw", "cooked", "dried", "unknown"]

function deterministicClassification(input: NormalizerInput): IngredientClassification {
  const name = input.foodName.trim()
  return {
    index: input.index,
    // No translation possible without the LLM — both fall back to the raw structured name
    // itself, exactly what every provider already falls back to when canonicalGerman/
    // canonicalEnglish are unavailable.
    canonicalGerman: name,
    canonicalEnglish: name,
    brand: null,
    state: "unknown",
    category: null,
    route: "generic",
    llmClassified: false,
  }
}

/**
 * A brand may only survive if it's actually evidenced in the structured food name we sent —
 * defense in depth against the LLM inferring a brand from world knowledge instead of the text
 * it was given. "Chobani Greek Yogurt" -> evidenced. "griechischer Joghurt" -> not evidenced,
 * forced to null regardless of what the model returned.
 */
function verifyBrandEvidence(brand: string | null, sourceFoodName: string): string | null {
  if (!brand) return null
  const normalizedBrand = brand.trim().toLowerCase()
  if (normalizedBrand.length === 0) return null
  const normalizedSource = sourceFoodName.toLowerCase()
  return normalizedSource.includes(normalizedBrand) ? brand.trim() : null
}

interface RawItem {
  index: unknown
  canonicalGerman: unknown
  canonicalEnglish: unknown
  brand: unknown
  state: unknown
  category: unknown
}

/** Strict structural validation — malformed output must fail safely, not throw or half-apply. */
function parseAndValidate(content: string, expectedCount: number): RawItem[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(content.replace(/```json\n?|```\n?/g, "").trim())
  } catch {
    return null
  }

  if (!Array.isArray(parsed)) return null
  if (parsed.length === 0 || parsed.length > expectedCount) return null

  const items: RawItem[] = []
  for (const raw of parsed) {
    if (typeof raw !== "object" || raw === null) return null
    const o = raw as Record<string, unknown>
    if (typeof o.index !== "number") return null
    if (typeof o.canonicalGerman !== "string") return null
    if (typeof o.canonicalEnglish !== "string") return null
    if (o.brand !== null && typeof o.brand !== "string") return null
    if (typeof o.state !== "string" || !VALID_STATES.includes(o.state as FoodState)) return null
    if (o.category !== null && typeof o.category !== "string") return null
    items.push({
      index: o.index,
      canonicalGerman: o.canonicalGerman,
      canonicalEnglish: o.canonicalEnglish,
      brand: o.brand,
      state: o.state,
      category: o.category,
    })
  }

  return items
}

function buildPrompt(inputs: NormalizerInput[]): string {
  const lines = inputs.map((i) => `${i.index}: name="${i.foodName}"${i.unitName ? `, unit="${i.unitName}"` : ""}`)
  return `You normalize recipe ingredients for a nutrition system. You are given ONLY the structured food name and unit for each ingredient below — there is no other text available, and none exists beyond what is shown. You are helping a downstream system UNDERSTAND each ingredient's identity for database lookup — you are NOT calculating or estimating any nutrient values here.

For each ingredient, return:
- canonicalGerman: a normalized German food identity (fix spelling/dialect, keep it food-identity-only)
- canonicalEnglish: the English translation of that same identity
- brand: a specific product brand ONLY if it is explicitly present as text within the given "name" field — otherwise null; never infer a brand from general knowledge about the food
- state: one of "raw", "cooked", "dried", "unknown" — only when clearly supported by the given name; do not guess if unsupported
- category: a short generic food category (e.g. "spice", "herb", "vegetable", "fruit", "dairy", "egg", "meat", "grain", "legume", "fat", "oil"), or null if unclear

CRITICAL: nutritionally-relevant qualifiers already present in the structured name must be PRESERVED in both canonicalGerman and canonicalEnglish — never dropped during cleanup or translation. This includes (German / English): roh/raw, gekocht|gegart/cooked, gebacken/baked, gebraten/fried, getrocknet/dry|dried, frisch/fresh, tiefgefroren/frozen, Dose|Konserve/canned, abgetropft/drained, geschält/peeled, mager/lean, Fett %/fat %, Vollfett/full-fat, fettarm/low-fat, fettfrei/fat-free, gesüßt/sweetened, ungesüßt/unsweetened, gesalzen/salted, ungesalzen/unsalted. Example: "mageres Rinderhackfleisch" -> canonicalGerman "Rinderhackfleisch, mager", canonicalEnglish "lean ground beef". Example: "Tomaten aus der Dose, abgetropft" must keep "canned"/"drained" in canonicalEnglish, not just "tomatoes". Do not invent a qualifier that isn't supported by the given name.

WATCH FOR FALSE FRIENDS: German "Paprika" qualified by a color (grüne/rote/gelbe Paprika = green/red/yellow Paprika) means the VEGETABLE (bell pepper) — canonicalEnglish must be "green/red/yellow bell pepper", never literal "green paprika" (in English, "paprika" alone means the ground spice, a completely different food with very different nutrition). Only unqualified "Paprikapulver" or bare "Paprika" meaning the spice should translate to "paprika"/"paprika powder".

Ingredients:
${lines.join("\n")}

Return ONLY a JSON array, one object per ingredient, in this exact shape, no explanation, no markdown:
[{"index":0,"canonicalGerman":"...","canonicalEnglish":"...","brand":null,"state":"raw","category":"..."}]`
}

async function callLlm(prompt: string): Promise<string | null> {
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
        max_tokens: 4000,
      }),
    })

    if (!res.ok) {
      logger.warn({ status: res.status }, "LLM batch normalization request failed")
      return null
    }

    const data: any = await res.json()
    const content = data?.choices?.[0]?.message?.content
    return typeof content === "string" ? content : null
  } catch (err) {
    logger.warn({ err }, "LLM batch normalization request threw")
    return null
  }
}

/**
 * ONE whole-recipe LLM classification request, per the skill's "one batch request, never one
 * per ingredient" rule. On any failure (disabled, no key, network error, malformed/invalid
 * JSON, even after one retry) this falls through to deterministic classification for every
 * ingredient — it never fans out into per-ingredient classification calls. Per-ingredient LLM
 * calls remain allowed elsewhere only for gram estimation of unresolved units and the final
 * per-ingredient nutrient fallback — never for this classification step.
 */
export async function normalizeIngredients(inputs: NormalizerInput[]): Promise<IngredientClassification[]> {
  if (inputs.length === 0) return []

  if (!config.llm.enabled || !config.llm.apiKey) {
    return inputs.map(deterministicClassification)
  }

  const prompt = buildPrompt(inputs)

  let content = await callLlm(prompt)
  let parsed = content ? parseAndValidate(content, inputs.length) : null

  if (!parsed) {
    logger.warn({ count: inputs.length }, "LLM batch normalization malformed, retrying once")
    content = await callLlm(`${prompt}\n\nYour previous response was not valid JSON matching the required shape. Return ONLY the JSON array, nothing else.`)
    parsed = content ? parseAndValidate(content, inputs.length) : null
  }

  if (!parsed) {
    logger.warn({ count: inputs.length }, "LLM batch normalization failed after retry, using deterministic fallback for all ingredients (no per-ingredient fan-out)")
    return inputs.map(deterministicClassification)
  }

  const byIndex = new Map(parsed.map((item) => [item.index, item]))

  return inputs.map((input) => {
    const item = byIndex.get(input.index)
    if (!item) return deterministicClassification(input)

    const brand = verifyBrandEvidence(item.brand as string | null, input.foodName)
    if (item.brand && !brand) {
      logger.info({ foodName: input.foodName, claimedBrand: item.brand }, "Rejected LLM brand claim — not evidenced in structured food name")
    }

    return {
      index: input.index,
      canonicalGerman: (item.canonicalGerman as string).trim() || input.foodName.trim(),
      canonicalEnglish: (item.canonicalEnglish as string).trim() || input.foodName.trim(),
      brand,
      state: item.state as FoodState,
      category: (item.category as string | null) ?? null,
      route: brand ? "branded" : "generic",
      llmClassified: true,
    }
  })
}
