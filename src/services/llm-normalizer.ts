import { config } from "../config.js"
import { logger } from "../utils/logger.js"
import { waitForRateLimit, RateLimitType } from "../utils/rate-limiter.js"
import type { FoodState, FoodType, IngredientClassification } from "../types.js"

export interface NormalizerInput {
  index: number
  /** Structured Mealie food.name — originalText must never reach this function. */
  foodName: string
  unitName: string | null
}

const VALID_STATES: FoodState[] = ["raw", "cooked", "dried", "unknown"]
const VALID_FOOD_TYPES: FoodType[] = ["simple", "processed_single_food", "composite_dish", "unknown"]

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
    // "unknown" is deliberately permissive (see foodTypeConflict in ranking.ts) — without the
    // LLM there's no reliable signal to hard-reject composite-dish candidates on the query side,
    // so this degrades to the existing lexical/category checks rather than blocking everything.
    foodType: "unknown",
    // null is permissive (see coreIdentityConflict in ranking.ts) for the same reason — without
    // the LLM there's no reliable core-noun signal to hard-reject on.
    coreFoodGerman: null,
    coreFoodEnglish: null,
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
  foodType: unknown
  coreFoodGerman: unknown
  coreFoodEnglish: unknown
}

/**
 * Why one item's validation failure is reported rather than just thrown away: the failure path
 * previously logged only `count`, so a live recipe whose classification collapsed could not be
 * diagnosed at all. `value` is populated ONLY for the two closed enums (state/foodType), whose
 * values are short and non-sensitive — never for free-text fields, never the raw response.
 */
interface ItemFailure {
  /** Position in the returned array — always known, even when `index` itself is unusable. */
  position: number
  /** The item's claimed ingredient index, when it was a number at all. */
  index: number | null
  field: string
  reason: string
  value?: string
}

/** Index integrity, recorded for diagnosis only — acceptance is deliberately unchanged here. */
interface IndexIssues {
  nonInteger: number
  outOfRange: number
  duplicate: number
}

type ParseOutcome =
  | { ok: true; items: RawItem[]; indexIssues: IndexIssues }
  | { ok: false; phase: "json"; contentLength: number }
  | { ok: false; phase: "shape"; isArray: boolean; length: number | null; expected: number }
  | {
      ok: false
      phase: "items"
      expected: number
      validCount: number
      failures: ItemFailure[]
      indexIssues: IndexIssues
    }

const ENUM_VALUE_MAX = 40

/** Short, closed-set values are safe to log; anything else is described by type only. */
function describeEnumValue(v: unknown): string {
  if (typeof v !== "string") return `<${v === null ? "null" : typeof v}>`
  return v.length > ENUM_VALUE_MAX ? `${v.slice(0, ENUM_VALUE_MAX)}…` : v
}

function validateItem(raw: unknown, position: number): { ok: true; item: RawItem } | { ok: false; failure: ItemFailure } {
  const at = (index: number | null, field: string, reason: string, value?: string) =>
    ({ ok: false, failure: { position, index, field, reason, value } }) as const

  if (typeof raw !== "object" || raw === null) return at(null, "<item>", `expected object, got ${raw === null ? "null" : typeof raw}`)
  const o = raw as Record<string, unknown>
  const idx = typeof o.index === "number" ? o.index : null

  if (typeof o.index !== "number") return at(null, "index", `expected number, got ${typeof o.index}`)
  if (typeof o.canonicalGerman !== "string") return at(idx, "canonicalGerman", `expected string, got ${typeof o.canonicalGerman}`)
  if (typeof o.canonicalEnglish !== "string") return at(idx, "canonicalEnglish", `expected string, got ${typeof o.canonicalEnglish}`)
  if (o.brand !== null && typeof o.brand !== "string") return at(idx, "brand", `expected string|null, got ${typeof o.brand}`)
  if (typeof o.state !== "string") return at(idx, "state", `expected string, got ${typeof o.state}`)
  if (!VALID_STATES.includes(o.state as FoodState)) return at(idx, "state", "not in allowed enum", describeEnumValue(o.state))
  if (o.category !== null && typeof o.category !== "string") return at(idx, "category", `expected string|null, got ${typeof o.category}`)
  if (typeof o.foodType !== "string") return at(idx, "foodType", `expected string, got ${typeof o.foodType}`)
  if (!VALID_FOOD_TYPES.includes(o.foodType as FoodType)) return at(idx, "foodType", "not in allowed enum", describeEnumValue(o.foodType))
  if (o.coreFoodGerman !== null && typeof o.coreFoodGerman !== "string") return at(idx, "coreFoodGerman", `expected string|null, got ${typeof o.coreFoodGerman}`)
  if (o.coreFoodEnglish !== null && typeof o.coreFoodEnglish !== "string") return at(idx, "coreFoodEnglish", `expected string|null, got ${typeof o.coreFoodEnglish}`)

  return {
    ok: true,
    item: {
      index: o.index,
      canonicalGerman: o.canonicalGerman,
      canonicalEnglish: o.canonicalEnglish,
      brand: o.brand,
      state: o.state,
      category: o.category,
      foodType: o.foodType,
      coreFoodGerman: o.coreFoodGerman,
      coreFoodEnglish: o.coreFoodEnglish,
    } as RawItem,
  }
}

/**
 * Strict structural validation — malformed output must fail safely, not throw or half-apply.
 *
 * Acceptance is intentionally IDENTICAL to before: any invalid item still fails the whole batch.
 * The only change is that every item is now inspected (instead of returning at the first bad one)
 * so the caller can report how many items were actually affected and which field broke.
 */
function parseAndValidate(content: string, expectedCount: number): ParseOutcome {
  let parsed: unknown
  const cleaned = content.replace(/```json\n?|```\n?/g, "").trim()
  try {
    parsed = JSON.parse(cleaned)
  } catch {
    return { ok: false, phase: "json", contentLength: cleaned.length }
  }

  if (!Array.isArray(parsed)) return { ok: false, phase: "shape", isArray: false, length: null, expected: expectedCount }
  if (parsed.length === 0 || parsed.length > expectedCount) {
    return { ok: false, phase: "shape", isArray: true, length: parsed.length, expected: expectedCount }
  }

  const items: RawItem[] = []
  const failures: ItemFailure[] = []
  const seen = new Set<number>()
  const indexIssues: IndexIssues = { nonInteger: 0, outOfRange: 0, duplicate: 0 }

  for (const [position, raw] of parsed.entries()) {
    const result = validateItem(raw, position)
    if (!result.ok) {
      failures.push(result.failure)
      continue
    }
    const idx = result.item.index as number
    if (!Number.isInteger(idx)) indexIssues.nonInteger++
    else if (idx < 0 || idx >= expectedCount) indexIssues.outOfRange++
    else if (seen.has(idx)) indexIssues.duplicate++
    seen.add(idx)
    items.push(result.item)
  }

  if (failures.length > 0) {
    return { ok: false, phase: "items", expected: expectedCount, validCount: items.length, failures, indexIssues }
  }
  return { ok: true, items, indexIssues }
}

function buildPrompt(inputs: NormalizerInput[]): string {
  const lines = inputs.map((i) => `${i.index}: name="${i.foodName}"${i.unitName ? `, unit="${i.unitName}"` : ""}`)
  return `You normalize recipe ingredients for a nutrition system. You are given ONLY the structured food name and unit for each ingredient below — there is no other text available, and none exists beyond what is shown. You are helping a downstream system UNDERSTAND each ingredient's identity for database lookup — you are NOT calculating or estimating any nutrient values here.

For each ingredient, return:
- canonicalGerman: a normalized German food identity (fix spelling/dialect, keep it food-identity-only)
- canonicalEnglish: the English translation of that same identity
- brand: a specific product brand ONLY if it is explicitly present as text within the given "name" field — otherwise null; never infer a brand from general knowledge about the food
- state: one of "raw", "cooked", "dried", "unknown" — only when clearly supported by the given name; do not guess if unsupported
- category: a short generic food category (e.g. "spice", "herb", "vegetable", "fruit", "dairy", "egg", "meat", "grain", "legume", "fat", "oil", "water", "beverage", "condiment", "seasoning"), or null if unclear. Plain water ("Wasser") is category "water", not "beverage" or null — this field is used to reject a candidate whose name merely happens to share a word with the query (e.g. plain water must never accept a product literally named "water" that isn't water, like a cracker or a soft drink), so pick the most specific matching category rather than defaulting to null when one of the examples clearly fits.
- foodType: one of "simple", "processed_single_food", "composite_dish", or "unknown" — see definitions and examples below. This field will be used to hard-reject a database match of the wrong type, so accuracy here matters more than most other fields.
- coreFoodGerman: the CORE food-identity noun within canonicalGerman — the base food itself, with every descriptive MODIFIER (color, origin/style, state/preparation, brand) stripped away. This is the single most important field: a database candidate whose name contains none of this word's tokens will be HARD-REJECTED, no matter how well it otherwise matches on a shared adjective. Never include a modifier here — only the base noun(s). Examples: "Zwiebel" for "rote Zwiebel" (modifier "rote" excluded), "Gewürzmischung" for "italienische Gewürzmischung" (modifier "italienische" excluded — NOT "italienische Gewürzmischung", NOT "Italian"), "Basilikum" for "getrockneter Basilikum" (modifier "getrocknet" excluded), "Paprika" for "grüne Paprika" (modifier "grüne" excluded), "Brühe" for "Gemüsebrühe" (the compound's head noun — "Gemüse" is the modifier), "Knoblauch" for "Knoblauchzehe"/"Knoblauchpulver" (the food is garlic; "-zehe"/"-pulver" describe the FORM, not a different food). If canonicalGerman IS just the base food with no modifiers (e.g. "Tomate", "Ei", "Salz"), coreFoodGerman equals canonicalGerman. null only if genuinely unclear.
- coreFoodEnglish: the same core identity in English, following the identical rule — e.g. "onion", "seasoning" (NOT "Italian seasoning"), "basil", "bell pepper", "broth", "garlic". null only if genuinely unclear.

foodType definitions:
- "simple": a single raw or minimally-prepared ingredient. Examples: tomato, salt, egg, olive oil, red lentils, chicken breast, green bell pepper, coriander (the herb), mint (the herb), water.
- "processed_single_food": one food that has been processed/preserved but is still fundamentally ONE food, not a dish with multiple ingredients combined into a new preparation. Examples: tomato paste, canned tuna, pickled cucumber, cheese, yogurt, dried herbs, paprika powder (the spice), garlic powder, breadcrumbs.
- "composite_dish": a prepared dish or menu component made of multiple ingredients combined together. Examples: lentil soup, stuffed pepper, rabbit stew, potato-tomato gratin, a prepared curry, breaded/coated chicken product, a dessert (cobbler, pudding, ice cream, cake), a sandwich, a sauce made of multiple ingredients, an Italian seasoning BLEND is composite only if it's sold as a finished sauce/dish — a plain dried-herb blend itself is "processed_single_food", not composite.
- "unknown": only when genuinely unclear from the given name.

If the ingredient name itself already names a composite dish (e.g. the Mealie ingredient literally says "Linsensuppe"/"lentil soup"), foodType must correctly be "composite_dish" — do not force everything to "simple".

CRITICAL: nutritionally-relevant qualifiers already present in the structured name must be PRESERVED in both canonicalGerman and canonicalEnglish — never dropped during cleanup or translation. This includes (German / English): roh/raw, gekocht|gegart/cooked, gebacken/baked, gebraten/fried, getrocknet/dry|dried, frisch/fresh, tiefgefroren/frozen, Dose|Konserve/canned, abgetropft/drained, geschält/peeled, mager/lean, Fett %/fat %, Vollfett/full-fat, fettarm/low-fat, fettfrei/fat-free, gesüßt/sweetened, ungesüßt/unsweetened, gesalzen/salted, ungesalzen/unsalted. Example: "mageres Rinderhackfleisch" -> canonicalGerman "Rinderhackfleisch, mager", canonicalEnglish "lean ground beef". Example: "Tomaten aus der Dose, abgetropft" must keep "canned"/"drained" in canonicalEnglish, not just "tomatoes". Do not invent a qualifier that isn't supported by the given name. Do not narrow "Ei" to egg white/yolk unless the given name explicitly says so — plain "Ei"/"Eier" means the whole egg. A bare "Öl" (oil, no type specified) must stay generic "oil" in canonicalEnglish — never invent a specific oil type (olive, coconut, ...) that isn't in the given name.

WATCH FOR FALSE FRIENDS: German "Paprika" qualified by a color (grüne/rote/gelbe Paprika = green/red/yellow Paprika) means the VEGETABLE (bell pepper) — canonicalEnglish must be "green/red/yellow bell pepper", never literal "green paprika" (in English, "paprika" alone means the ground spice, a completely different food with very different nutrition). Only unqualified "Paprikapulver" or bare "Paprika" meaning the spice should translate to "paprika"/"paprika powder".

Ingredients:
${lines.join("\n")}

Return ONLY a JSON array, one object per ingredient, in this exact shape, no explanation, no markdown:
[{"index":0,"canonicalGerman":"...","canonicalEnglish":"...","brand":null,"state":"raw","category":"...","foodType":"simple","coreFoodGerman":"...","coreFoodEnglish":"..."}]`
}

/**
 * Outcome of one LLM call, with the failure CLASS preserved rather than collapsed into null.
 * The live Linsensuppe incident could not be diagnosed from production logs because every one of
 * these classes logged the same (or, for a non-string content field, nothing at all) — so the
 * whole-recipe classification silently degraded to the deterministic fallback with no way to tell
 * a network blip from a schema violation. Diagnostics only: callers still treat every !ok the
 * same way they treated null.
 */
type CallOutcome =
  | { ok: true; content: string }
  | { ok: false; phase: "request-network" | "request-status" | "response-body" | "response-shape" }

async function callLlm(prompt: string, attempt: number): Promise<CallOutcome> {
  let res: Response
  try {
    await waitForRateLimit(RateLimitType.Llm)

    res = await fetch(`${config.llm.baseUrl}${config.llm.endpointUrl}`, {
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
  } catch (err) {
    // Name/message only — never the error object, which can carry request/response detail.
    logger.warn(
      { attempt, phase: "request-network", errName: (err as Error).name, errMessage: (err as Error).message },
      "LLM batch normalization: network/request failure",
    )
    return { ok: false, phase: "request-network" }
  }

  if (!res.ok) {
    logger.warn({ attempt, phase: "request-status", status: res.status }, "LLM batch normalization: HTTP error status")
    return { ok: false, phase: "request-status" }
  }

  let data: any
  try {
    data = await res.json()
  } catch (err) {
    logger.warn(
      { attempt, phase: "response-body", errName: (err as Error).name },
      "LLM batch normalization: response body was not JSON",
    )
    return { ok: false, phase: "response-body" }
  }

  const content = data?.choices?.[0]?.message?.content
  if (typeof content !== "string") {
    // Previously returned null with NO log at all — a completely silent failure class.
    logger.warn(
      {
        attempt,
        phase: "response-shape",
        hasChoices: Array.isArray(data?.choices),
        choiceCount: Array.isArray(data?.choices) ? data.choices.length : 0,
        contentType: content === undefined ? "undefined" : content === null ? "null" : typeof content,
        finishReason: typeof data?.choices?.[0]?.finish_reason === "string" ? data.choices[0].finish_reason : null,
      },
      "LLM batch normalization: response envelope missing a string content field",
    )
    return { ok: false, phase: "response-shape" }
  }

  return { ok: true, content }
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

  const attemptOnce = async (p: string, attempt: number): Promise<RawItem[] | null> => {
    const call = await callLlm(p, attempt)
    if (!call.ok) return null // already logged with its specific phase

    const outcome = parseAndValidate(call.content, inputs.length)
    if (outcome.ok) {
      // Index integrity is reported even on an otherwise-accepted batch: a duplicate or
      // out-of-range index makes byIndex silently drop an ingredient to the deterministic
      // fallback, which previously looked identical to a clean success in the logs.
      const { nonInteger, outOfRange, duplicate } = outcome.indexIssues
      if (nonInteger + outOfRange + duplicate > 0) {
        logger.warn(
          { attempt, phase: "index-integrity", expected: inputs.length, returned: outcome.items.length, indexIssues: outcome.indexIssues },
          "LLM batch normalization: accepted batch has index integrity problems — some ingredients will fall back deterministically",
        )
      }
      return outcome.items
    }

    // One line per failure CLASS, structured metadata only — no response text, no recipe content.
    if (outcome.phase === "json") {
      logger.warn({ attempt, phase: "json", contentLength: outcome.contentLength }, "LLM batch normalization: content was not parseable JSON")
    } else if (outcome.phase === "shape") {
      logger.warn(
        { attempt, phase: "shape", isArray: outcome.isArray, length: outcome.length, expected: outcome.expected },
        "LLM batch normalization: JSON parsed but was not an array of the expected size",
      )
    } else {
      logger.warn(
        {
          attempt,
          phase: "items",
          expected: outcome.expected,
          validCount: outcome.validCount,
          invalidCount: outcome.failures.length,
          indexIssues: outcome.indexIssues,
          // Bounded: the first few failures are enough to identify the offending field.
          failures: outcome.failures.slice(0, 5),
        },
        "LLM batch normalization: per-item validation failed",
      )
    }
    return null
  }

  let parsed = await attemptOnce(prompt, 1)

  if (!parsed) {
    logger.warn({ count: inputs.length }, "LLM batch normalization malformed, retrying once")
    parsed = await attemptOnce(
      `${prompt}\n\nYour previous response was not valid JSON matching the required shape. Return ONLY the JSON array, nothing else.`,
      2,
    )
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

    const coreFoodGerman = (item.coreFoodGerman as string | null)?.trim() || null
    const coreFoodEnglish = (item.coreFoodEnglish as string | null)?.trim() || null

    return {
      index: input.index,
      canonicalGerman: (item.canonicalGerman as string).trim() || input.foodName.trim(),
      canonicalEnglish: (item.canonicalEnglish as string).trim() || input.foodName.trim(),
      brand,
      state: item.state as FoodState,
      category: (item.category as string | null) ?? null,
      foodType: item.foodType as FoodType,
      coreFoodGerman,
      coreFoodEnglish,
      route: brand ? "branded" : "generic",
      llmClassified: true,
    }
  })
}
