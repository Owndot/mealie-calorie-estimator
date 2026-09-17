import { config } from "../config.js"
import { __testing, parseJudgeReply } from "../services/providers/judge/judge.js"
import type { JudgeCandidate, JudgeQuery, JudgeDecision } from "../services/providers/judge/types.js"

/**
 * BENCHMARK ONLY — the judge, told that evidence may be written in another language.
 *
 * Measured with the English-only property prompt: shown Edeka's "Mageres Rinderhackfleisch zum
 * Braten" and asked whether any candidate states a reduced-fat claim, the model answered NONE five
 * times out of five — "no candidate explicitly states 'lean' or a reduced-fat claim". The product
 * was in the shortlist. The model simply did not read the German wording as the English concept it
 * had been given.
 *
 * So this variant changes WHAT THE MODEL IS SHOWN, not what it is told to conclude. It supplies
 * the ingredient text as the user actually wrote it, the normalized English identity, the requested
 * attribute as a CONCEPT, and every candidate name exactly as its database stores it — and says
 * plainly that these may be in different languages and that the original wording must be judged on
 * its own terms.
 *
 * Deliberately NOT here: any mapping from one language's word to another's. No "mager -> lean", no
 * synonym table, nothing food-specific. The model is asked to do multilingual reading, which it can
 * do in general; it was previously just not asked to.
 */

const MULTILINGUAL = `
MULTILINGUAL EVIDENCE
The ingredient text and the candidate names may be written in DIFFERENT LANGUAGES. The normalized
identity and the requested attribute below are given in English, but every candidate name is
reproduced exactly as its database stores it — which may be German, French or another language.

Judge each candidate's ORIGINAL wording on its own terms: decide whether that wording, in its own
language, expresses the requested concept. Do not require an English word to be present, and do not
treat a non-English label as silent merely because it is not in English. Equally, do not invent a
claim a label does not make.`

export async function askMultilingualJudge(
  q: JudgeQuery,
  candidates: JudgeCandidate[],
  currentRecordName: string,
  propertyDescription: string,
  propertyKind: string,
): Promise<{ decision: JudgeDecision | null; invalidReason?: string; latencyMs: number; promptTokens: number; completionTokens: number }> {
  const t0 = Date.now()

  // The qualitative/numeric distinction is a rule about EVIDENCE, not about any food: a number is
  // only usable when the ingredient stated a number.
  const claimRule = propertyKind === "numeric-fat"
    ? `The ingredient states an explicit number. A candidate whose own name or label states that same number is legitimate evidence.`
    : `The ingredient states a QUALITATIVE claim and no number. Do NOT infer a numeric grade from it, and do NOT prefer a candidate for having less fat or fewer calories. A product explicitly labelled with the qualitative concept is stronger evidence than any numeric grade.`

  const user = `${__testing.buildUserPrompt(q, candidates)}
${MULTILINGUAL}

UNRESOLVED PROPERTY
Original ingredient text, exactly as written: "${q.structuredName}"
Normalized identity (English): "${q.canonicalEnglish}"
Requested attribute: ${propertyDescription}
The record currently in use is "${currentRecordName}", and it does NOT satisfy that attribute.

${claimRule}

Select a candidate ONLY if its own wording expresses the requested attribute. If none does, answer
"none". If several do and the ingredient gives no basis to choose between them, answer "ambiguous".
Keeping the current record is the safe outcome; only positive evidence is worth replacing it.`

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
