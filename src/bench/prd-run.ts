import { initCache } from "../utils/cache.js"
import { config } from "../config.js"
import { resolveNutrients } from "../services/nutrient-resolver.js"
import { getProviderChain } from "../services/providers/registry.js"
import { askJudge, JUDGE_PROMPT_VERSION } from "../services/providers/judge/judge.js"
import { orderCandidates } from "../services/providers/judge/candidate-pool.js"
import { buildShortlist } from "./shortlist.js"
import { searchOff, filterOffHits, offProxyJustified } from "./off-proxy.js"
import { askPropertyJudge } from "./property-judge.js"
import { askMultilingualJudge } from "./multilingual-judge.js"
import { UNKNOWN_ATTRIBUTES, type FoodAttributes, type FoodType } from "../types.js"
import type { JudgeCandidate } from "../services/providers/judge/types.js"

/**
 * BENCHMARK ONLY — read-only evaluation of PR D's replacement candidates.
 *
 * Touches no Mealie data: it never calls estimateRecipe, never patches a recipe, never writes a
 * tag. It resolves single ingredients through the existing chain to capture the CURRENT answer,
 * builds the attribute-aware shortlist, optionally consults OFF as a verified proxy, and asks the
 * judge once per candidate-order permutation. Nutrients always come from the selected record.
 *
 * Run with CACHE_DB_PATH pointed at a throwaway file so the production cache is untouched.
 */

interface Case {
  id: string
  /** The EXACT production classification, as recorded in calorie_estimator_provenance. */
  structured: string
  german: string
  english: string
  coreDe: string | null
  coreEn: string | null
  category: string | null
  foodType: FoodType
  state: string
  attrs?: Partial<FoodAttributes>
  /** Live OFF search text. Previous barcodes are controls, never assumptions. */
  offQuery: string
  /** Barcodes the earlier benchmark found, checked for presence only. */
  controls?: string[]
  expect: string
}

const CASES: Case[] = [
  {
    id: "beef-lean", structured: "Rinderhackfleisch mager", german: "Rinderhackfleisch, mager",
    english: "lean ground beef", coreDe: "Rinderhackfleisch", coreEn: "ground beef",
    category: "meat", foodType: "simple", state: "raw",
    offQuery: "mageres Rinderhackfleisch", controls: ["4313249214975"],
    expect: "a record that STATES lean, or AMBIGUOUS — never a numeric grade standing in for 'mager'",
  },
  {
    id: "beef-10", structured: "Rinderhack 10% Fett", german: "Rinderhackfleisch 10 % Fett",
    english: "ground beef 10% fat", coreDe: "Rinderhackfleisch", coreEn: "ground beef",
    category: "meat", foodType: "simple", state: "raw", attrs: { fatPercent: 10 },
    offQuery: "Rinderhackfleisch 10% Fett",
    expect: "the 90/10 record — an explicit number is legitimate evidence",
  },
  {
    id: "beef-5", structured: "Rinderhack 5% Fett", german: "Rinderhackfleisch 5 % Fett",
    english: "ground beef 5% fat", coreDe: "Rinderhackfleisch", coreEn: "ground beef",
    category: "meat", foodType: "simple", state: "raw", attrs: { fatPercent: 5 },
    offQuery: "Rinderhackfleisch 5% Fett",
    expect: "the 95/5 record",
  },
  {
    id: "mayo-light-prod", structured: "Mayo Light", german: "Mayonnaise, leicht",
    english: "light mayo", coreDe: "Mayonnaise", coreEn: "mayo",
    category: "condiment", foodType: "processed_single_food", state: "unknown",
    offQuery: "Mayonnaise Light",
    expect: "PRODUCTION CORE: USDA light records are hard-rejected before the judge sees them",
  },
  {
    id: "mayo-light-normalized", structured: "Mayo Light", german: "Mayonnaise, leicht",
    english: "light mayonnaise", coreDe: "Mayonnaise", coreEn: "mayonnaise",
    category: "condiment", foodType: "processed_single_food", state: "unknown",
    offQuery: "Mayonnaise Light",
    expect: "NORMALIZED CORE: a genuine light mayonnaise, or AMBIGUOUS between materially different ones",
  },
  {
    id: "kochsahne-7", structured: "Kochsahne 7%", german: "Kochsahne 7 % Fett",
    english: "cooking cream 7% fat", coreDe: "Sahne", coreEn: "cream",
    category: "dairy", foodType: "processed_single_food", state: "unknown", attrs: { fatPercent: 7 },
    offQuery: "Kochsahne 7% Fett", controls: ["4061458212588"],
    expect: "a real 7% cooking cream, or NONE",
  },
  {
    id: "kochsahne-15", structured: "Kochsahne 15%", german: "Kochsahne 15 % Fett",
    english: "cooking cream 15% fat", coreDe: "Sahne", coreEn: "cream",
    category: "dairy", foodType: "processed_single_food", state: "unknown", attrs: { fatPercent: 15 },
    offQuery: "Kochsahne 15% Fett", controls: ["4016241020130"],
    expect: "a real 15% cooking cream, or NONE",
  },
]

const PERMUTATIONS = 5

/** Deterministic rotations, so the same run is reproducible and every candidate leads once. */
const rotate = <T>(a: T[], n: number): T[] => (a.length === 0 ? a : [...a.slice(n % a.length), ...a.slice(0, n % a.length)])

function line(c: JudgeCandidate): string {
  const n = c.nutrients
  return `${c.id.padEnd(24)} ${c.name.slice(0, 52).padEnd(53)} ${String(n.kcalPer100g).padStart(8)}kcal fat=${String(n.fatPer100g).padStart(6)} s=${Math.round(c.score)}`
}

async function main(): Promise<void> {
  await initCache()
  const totals = { calls: 0, prompt: 0, completion: 0, latency: 0, invalid: 0 }

  console.log(`BENCH-START model=${config.llm.judgeModel} prompt=${JUDGE_PROMPT_VERSION} cases=${CASES.length} permutations=${PERMUTATIONS}`)
  console.log(`BENCH-CONFIG judgeEnabled=${config.llm.judgeEnabled} maxCandidates=${config.llm.judgeMaxCandidates} minConfidence=${config.llm.judgeMinConfidence}`)

  for (const c of CASES) {
    const attributes = { ...UNKNOWN_ATTRIBUTES, ...c.attrs }
    const query = {
      foodName: c.english, structuredName: c.structured, canonicalGerman: c.german, brand: null,
      category: c.category, state: c.state, foodType: c.foodType,
      coreFoodGerman: c.coreDe, coreFoodEnglish: c.coreEn, route: "generic", attributes,
      evidence: { german: true, english: true, core: true, brand: false },
    }

    console.log(`\n${"=".repeat(110)}`)
    console.log(`CASE ${c.id}  | structured="${c.structured}" german="${c.german}" english="${c.english}"`)
    console.log(`  CLASSIFICATION core_de="${c.coreDe}" core_en="${c.coreEn}" category=${c.category} foodType=${c.foodType} state=${c.state} attrs=${JSON.stringify(attributes)}`)
    console.log(`  EXPECT ${c.expect}`)

    const current = await resolveNutrients(query as never, "generic")
    console.log(`  CURRENT ${current
      ? `${current.fallbackStatus} ${current.match.providerId} "${current.match.productName}" ${current.match.nutrients.kcalPer100g}kcal fat=${current.match.nutrients.fatPer100g} conf=${current.match.confidence} unmet=${JSON.stringify(current.match.unmetAttributes ?? [])}`
      : "unresolved"}`)

    // Hard-gate survivors from the two LOCAL databases, with no score floor.
    const survivors: JudgeCandidate[] = []
    for (const provider of getProviderChain("generic")) {
      if (provider.name !== "bls" && provider.name !== "usda-local") continue
      try {
        await provider.lookup({ ...query, poolOnly: true, candidateSink: (x: JudgeCandidate[]) => { survivors.push(...x) } } as never)
      } catch { /* a provider that cannot answer contributes nothing */ }
    }

    const localOnly = buildShortlist(survivors, c.structured, attributes, config.llm.judgeMaxCandidates)
    console.log(`  PROPERTY ${localOnly.property.kind} — ${localOnly.property.description}`)
    console.log(`  SURVIVORS ${localOnly.totalSurvivors} (hard gates passed, no score floor)`)
    console.log(`  PROPERTY-BEARING ${localOnly.propertyBearing.length}`)
    for (const p of localOnly.propertyBearing.slice(0, 12)) console.log(`      ${line(p)}`)
    console.log(`  LOST TO A PLAIN TOP-${config.llm.judgeMaxCandidates} SCORE CAP: ${localOnly.rescuedFromTruncation.length}`)
    for (const p of localOnly.rescuedFromTruncation) console.log(`      rescued ${line(p)}`)

    // OFF only when the local databases cannot express the property.
    const justification = offProxyJustified(localOnly.propertyBearing, localOnly.property.kind)
    let offCandidates: JudgeCandidate[] = []
    console.log(`  OFF ROUTING ${justification.justified ? "JUSTIFIED" : "SKIPPED"} — ${justification.why}`)
    if (justification.justified) {
      const hits = await searchOff(c.offQuery)
      const filtered = filterOffHits(hits, [c.coreDe, c.coreEn], attributes)
      offCandidates = filtered.kept
      console.log(`  OFF "${c.offQuery}" ${filtered.rawHits} hits -> ${offCandidates.length} after the strict filter`)
      for (const o of offCandidates.slice(0, 8)) console.log(`      ${line(o)} brand=${o.brand ?? "-"}`)
      for (const [why, n] of Object.entries(filtered.dropped)) console.log(`      filtered: ${n}x ${why}`)
      for (const control of c.controls ?? []) {
        const present = offCandidates.some((o) => o.providerId === control)
        console.log(`      CONTROL ${control}: ${present ? "still findable" : "NOT found live"}`)
      }
    }

    // Rebuilt WITH the retail survivors, so they get places of their own rather than competing on
    // a score they do not have.
    const shortlist = buildShortlist(survivors, c.structured, attributes, config.llm.judgeMaxCandidates, offCandidates)
    const finalPool = shortlist.offered
    console.log(`  FINAL SHORTLIST ${finalPool.length} (retail represented: ${finalPool.filter((p) => p.provider === "off").length}/${offCandidates.length})`)
    for (const p of finalPool) console.log(`      ${line(p)}`)

    if (finalPool.length === 0) {
      console.log(`  JUDGE skipped — nothing to choose between`)
      continue
    }

    const outcomes: string[] = []
    for (let i = 0; i < PERMUTATIONS; i++) {
      const permuted = rotate(finalPool, i * 3 + 1)
      const out = await askJudge({
        structuredName: c.structured, canonicalEnglish: c.english, canonicalGerman: c.german,
        coreFoodEnglish: c.coreEn, state: c.state, form: attributes.form,
        preservation: attributes.preservation, fatPercent: attributes.fatPercent, category: c.category,
      }, permuted)

      totals.calls++
      totals.prompt += out.promptTokens
      totals.completion += out.completionTokens
      totals.latency += out.latencyMs
      if (!out.decision) totals.invalid++

      const d = out.decision
      const picked = d?.candidateId ? permuted.find((p) => p.id === d.candidateId) : null
      outcomes.push(d ? `${d.verdict}:${d.candidateId ?? "-"}` : `invalid:${out.invalidReason ?? "?"}`)
      console.log(`  PERM ${i} lead=${permuted[0].id.padEnd(24)} -> ${d ? d.verdict.toUpperCase() : `INVALID(${out.invalidReason})`}` +
        `${picked ? ` ${picked.id} "${picked.name.slice(0, 40)}" ${picked.nutrients.kcalPer100g}kcal fat=${picked.nutrients.fatPer100g}` : ""}` +
        ` conf=${d?.confidence ?? "-"} ${out.latencyMs}ms ${out.promptTokens}+${out.completionTokens}tok${out.cached ? " CACHED" : ""}`)
      if (d?.reason) console.log(`         reason: ${d.reason}`)
    }

    const unique = [...new Set(outcomes)]
    console.log(`  STABILITY ${unique.length === 1 ? "STABLE" : "UNSTABLE"} across ${PERMUTATIONS} permutations -> ${JSON.stringify(unique)}`)

    // Same pools, same permutations, but the model is told WHICH property went unsatisfied.
    if (current?.match.productName && localOnly.property.kind !== "none") {
      const propOutcomes: string[] = []
      for (let i = 0; i < PERMUTATIONS; i++) {
        const permuted = rotate(finalPool, i * 3 + 1)
        const out = await askPropertyJudge({
          structuredName: c.structured, canonicalEnglish: c.english, canonicalGerman: c.german,
          coreFoodEnglish: c.coreEn, state: c.state, form: attributes.form,
          preservation: attributes.preservation, fatPercent: attributes.fatPercent, category: c.category,
        }, permuted, current.match.productName, localOnly.property.description)
        totals.calls++
        totals.prompt += out.promptTokens
        totals.completion += out.completionTokens
        totals.latency += out.latencyMs
        if (!out.decision) totals.invalid++
        const d = out.decision
        const picked = d?.candidateId ? permuted.find((p) => p.id === d.candidateId) : null
        propOutcomes.push(d ? `${d.verdict}:${d.candidateId ?? "-"}` : `invalid:${out.invalidReason ?? "?"}`)
        console.log(`  PROP ${i} -> ${d ? d.verdict.toUpperCase() : `INVALID(${out.invalidReason})`}` +
          `${picked ? ` ${picked.id} "${picked.name.slice(0, 40)}" ${picked.nutrients.kcalPer100g}kcal fat=${picked.nutrients.fatPer100g}` : ""} conf=${d?.confidence ?? "-"}`)
        if (d?.reason) console.log(`         reason: ${d.reason}`)
      }
      const pu = [...new Set(propOutcomes)]
      console.log(`  PROP-STABILITY ${pu.length === 1 ? "STABLE" : "UNSTABLE"} -> ${JSON.stringify(pu)}`)

      // Third variant: same pools, same permutations, evidence read across languages.
      const mlOutcomes: string[] = []
      for (let i = 0; i < PERMUTATIONS; i++) {
        const permuted = rotate(finalPool, i * 3 + 1)
        const out = await askMultilingualJudge({
          structuredName: c.structured, canonicalEnglish: c.english, canonicalGerman: c.german,
          coreFoodEnglish: c.coreEn, state: c.state, form: attributes.form,
          preservation: attributes.preservation, fatPercent: attributes.fatPercent, category: c.category,
        }, permuted, current.match.productName!, shortlist.property.description, shortlist.property.kind)
        totals.calls++
        totals.prompt += out.promptTokens
        totals.completion += out.completionTokens
        totals.latency += out.latencyMs
        if (!out.decision) totals.invalid++
        const d = out.decision
        const picked = d?.candidateId ? permuted.find((p) => p.id === d.candidateId) : null
        mlOutcomes.push(d ? `${d.verdict}:${d.candidateId ?? "-"}` : `invalid:${out.invalidReason ?? "?"}`)
        console.log(`  MULTI ${i} -> ${d ? d.verdict.toUpperCase() : `INVALID(${out.invalidReason})`}` +
          `${picked ? ` ${picked.id} "${picked.name.slice(0, 44)}" ${picked.nutrients.kcalPer100g}kcal fat=${picked.nutrients.fatPer100g}` : ""} conf=${d?.confidence ?? "-"}`)
        if (d?.reason) console.log(`         reason: ${d.reason}`)
      }
      const mu = [...new Set(mlOutcomes)]
      console.log(`  MULTI-STABILITY ${mu.length === 1 ? "STABLE" : "UNSTABLE"} -> ${JSON.stringify(mu)}`)
    }
    const wouldApply = unique.length === 1 && outcomes[0].startsWith("selected:")
    console.log(`  WOULD REPLACE: ${wouldApply ? outcomes[0].slice("selected:".length) : "no — keeping the deterministic result"}`)
  }

  const avg = totals.calls ? Math.round(totals.latency / totals.calls) : 0
  // gpt-4o-mini list pricing, USD per 1M tokens, for an order-of-magnitude figure only.
  const cost = (totals.prompt / 1e6) * 0.15 + (totals.completion / 1e6) * 0.60
  console.log(`\nBENCH-SUMMARY calls=${totals.calls} invalid=${totals.invalid} promptTok=${totals.prompt} completionTok=${totals.completion} avgLatencyMs=${avg} approxUsd=${cost.toFixed(4)}`)
  console.log("BENCH-END")
}

main().catch((err) => {
  console.log(`BENCH-FATAL ${(err as Error).message}`)
  process.exit(0)
})
