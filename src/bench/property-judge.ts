import { config } from "../config.js"
import { __testing, parseJudgeReply } from "../services/providers/judge/judge.js"
import type { JudgeCandidate, JudgeQuery, JudgeDecision } from "../services/providers/judge/types.js"

/**
 * BENCHMARK ONLY — the judge, told WHICH PROPERTY is unresolved.
 *
 * Measured with the shipped prompt: shown "Rind Hackfleisch, roh" (the current record, which says
 * nothing about fat) alongside Edeka's "Mageres Rinderhackfleisch zum Braten", the model picked
 * the current record five times out of five, reasoning "raw ground beef matches lean ground beef".
 * That is a correct answer to the question it was asked — "which candidate is the same food?" —
 * and the wrong question for a replacement decision.
 *
 * PR D asks something narrower: this record FAILED a specific claim; does any candidate positively
 * state it? This variant puts that question to the model so the two prompts can be compared on the
 * same pools. Production's askJudge() is untouched.
 */
export async function askPropertyJudge(
  q: JudgeQuery,
  candidates: JudgeCandidate[],
  currentRecordName: string,
  propertyDescription: string,
): Promise<{ decision: JudgeDecision | null; invalidReason?: string; latencyMs: number; promptTokens: number; completionTokens: number }> {
  const t0 = Date.now()
  const user = `${__testing.buildUserPrompt(q, candidates)}

UNRESOLVED PROPERTY
The record currently in use is "${currentRecordName}", and it does NOT satisfy: ${propertyDescription}.
Select a candidate ONLY if that candidate POSITIVELY STATES the property — in its own name, as the
product it is. A candidate that merely has less fat or fewer calories does NOT state it, and a
numeric grade does not answer a qualitative claim.
If no candidate states the property, answer "none". If several state it and the ingredient gives no
basis to choose between them, answer "ambiguous". Keeping the current record is the safe outcome;
only a candidate with positive evidence is worth replacing it.`

  try {
    const res = await fetch(`${config.llm.baseUrl}${config.llm.endpointUrl}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.llm.apiKey}` },
      body: JSON.stringify({
        model: config.llm.judgeModel,
        messages: [{ role: "system", content: __testing.SYSTEM }, { role: "user", content: user }],
        temperature: 0,
        response_format: { type: "json_object" },
      }),
    })
    if (!res.ok) return { decision: null, invalidReason: `http ${res.status}`, latencyMs: Date.now() - t0, promptTokens: 0, completionTokens: 0 }
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } }
    const parsed = parseJudgeReply(data.choices?.[0]?.message?.content ?? "", candidates)
    return {
      ...parsed,
      latencyMs: Date.now() - t0,
      promptTokens: data.usage?.prompt_tokens ?? 0,
      completionTokens: data.usage?.completion_tokens ?? 0,
    }
  } catch (err) {
    return { decision: null, invalidReason: `request failed: ${(err as Error).name}`, latencyMs: Date.now() - t0, promptTokens: 0, completionTokens: 0 }
  }
}
