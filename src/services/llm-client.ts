import { config } from "../config.js"
import { logger } from "../utils/logger.js"
import { waitForRateLimit, RateLimitType } from "../utils/rate-limiter.js"

/**
 * The single place this project talks to an LLM endpoint.
 *
 * Extracted from llm-normalizer.ts so every LLM feature shares one client, one rate limiter and
 * one set of failure classes, rather than each growing its own fetch with subtly different
 * behaviour. Nothing here knows what the prompt is for.
 */

/**
 * Outcome of one LLM call, with the failure CLASS preserved rather than collapsed into null.
 * The live Linsensuppe incident could not be diagnosed from production logs because every one of
 * these classes logged the same (or, for a non-string content field, nothing at all) — so the
 * whole-recipe classification silently degraded to the deterministic fallback with no way to tell
 * a network blip from a schema violation. Diagnostics only: callers still treat every !ok the
 * same way they treated null.
 */
export type CallOutcome =
  | { ok: true; content: string }
  | { ok: false; phase: "request-network" | "request-status" | "response-body" | "response-shape" | "timeout" }

export interface CallOptions {
  /** Deterministic-ish output is what every caller here wants; overridable per feature. */
  temperature?: number
  maxTokens?: number
  /** Abort the request after this many ms. Omitted means no client-side deadline. */
  timeoutMs?: number
  /** Included in every log line so a failure can be attributed to a feature. */
  purpose: string
  /** Retry counter, for logs only. */
  attempt?: number
}

export async function callLlm(prompt: string, options: CallOptions): Promise<CallOutcome> {
  const { purpose, attempt = 1, temperature = 0.1, maxTokens = 4000, timeoutMs } = options
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
        temperature,
        max_tokens: maxTokens,
      }),
      // A hung request must not hold up a whole recipe. AbortSignal.timeout surfaces as a
      // TimeoutError from fetch, which the catch below classifies separately from a network fault
      // so the two remain distinguishable in logs.
      ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
    })
  } catch (err) {
    const name = (err as Error).name
    const phase = name === "TimeoutError" || name === "AbortError" ? "timeout" : "request-network"
    // Name/message only — never the error object, which can carry request/response detail.
    logger.warn(
      { purpose, attempt, phase, errName: name, errMessage: (err as Error).message },
      "LLM call: network/request failure",
    )
    return { ok: false, phase }
  }

  if (!res.ok) {
    logger.warn({ purpose, attempt, phase: "request-status", status: res.status }, "LLM call: HTTP error status")
    return { ok: false, phase: "request-status" }
  }

  let data: unknown
  try {
    data = await res.json()
  } catch (err) {
    logger.warn({ purpose, attempt, phase: "response-body", errName: (err as Error).name }, "LLM call: response body was not JSON")
    return { ok: false, phase: "response-body" }
  }

  const envelope = data as { choices?: { message?: { content?: unknown }; finish_reason?: unknown }[] }
  const content = envelope?.choices?.[0]?.message?.content
  if (typeof content !== "string") {
    // Previously returned null with NO log at all — a completely silent failure class.
    logger.warn(
      {
        purpose,
        attempt,
        phase: "response-shape",
        hasChoices: Array.isArray(envelope?.choices),
        choiceCount: Array.isArray(envelope?.choices) ? envelope.choices.length : 0,
        contentType: content === undefined ? "undefined" : content === null ? "null" : typeof content,
        finishReason: typeof envelope?.choices?.[0]?.finish_reason === "string" ? envelope.choices[0].finish_reason : null,
      },
      "LLM call: response envelope missing a string content field",
    )
    return { ok: false, phase: "response-shape" }
  }

  return { ok: true, content }
}
