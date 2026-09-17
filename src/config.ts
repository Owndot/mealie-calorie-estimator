import { createRequire } from "module"
const { version } = createRequire(import.meta.url)("../package.json")

export function getMealieToken(householdId?: string | null): string {
  if (householdId) {
    const key =
      "MEALIE_API_TOKEN_" +
      householdId.replace(/[^A-Za-z0-9_]/g, "_")
    const token = process.env[key]
    if (token) return token
  }

  if (config.mealie.apiToken) return config.mealie.apiToken

  const fallbackKey = Object.keys(process.env).find((k) =>
    k.startsWith("MEALIE_API_TOKEN_"),
  )
  if (fallbackKey) return process.env[fallbackKey]!

  return ""
}

function hasAnyToken(): boolean {
  if (process.env.MEALIE_API_TOKEN) return true
  return Object.keys(process.env).some((k) => k.startsWith("MEALIE_API_TOKEN_"))
}

export const config = {
  port: parseInt(process.env.PORT || "8000", 10),

  mealie: {
    url: process.env.MEALIE_URL || "http://mealie:9000",
    apiToken: process.env.MEALIE_API_TOKEN || "",
    timeoutMs: parseInt(process.env.MEALIE_TIMEOUT_MS || "30000", 10),
  },

  // Only the /search endpoint is used (off-provider.ts) — there is no product-barcode lookup in
  // this codebase, so no product-endpoint base URL or rate limit is declared here.
  openFoodFacts: {
    searchBaseUrl: process.env.OFF_SEARCH_BASE_URL || "https://search.openfoodfacts.org",
    language: process.env.OFF_LANGUAGE || "de",
    searchRateLimit: parseInt(process.env.OFF_SEARCH_RATE_LIMIT || "10", 10),
    maxRetries: parseInt(process.env.OFF_MAX_RETRIES || "3", 10),
    retryBackoffMs: parseInt(process.env.OFF_RETRY_BACKOFF_MS || "500", 10),
    userAgent: process.env.OFF_USER_AGENT || `mealie-calorie-estimator/${version} (mail@timo-reymann.de)`,
  },

  llm: {
    enabled: (process.env.LLM_ENABLED || "false").toLowerCase() === "true",
    baseUrl: process.env.LLM_BASE_URL || "https://api.mistral.ai/v1",
    endpointUrl: process.env.LLM_ENDPOINT_URL || "/chat/completions",
    apiKey: process.env.LLM_API_KEY || "",
    model: process.env.LLM_MODEL || "mistral-small-latest",
    rateLimit: parseInt(process.env.LLM_RATE_LIMIT || "30", 10),
    // Candidate reranking: the LLM as a semantic judge between DATABASE records that retrieval
    // already found, never as a source of nutrition. Requires LLM_ENABLED + LLM_API_KEY as well;
    // this flag only controls whether the reranking step is offered at all.
    rerankEnabled: (process.env.LLM_RERANK_ENABLED || "true").toLowerCase() === "true",
    /** Small on purpose: the whole point is that retrieval stays local and the prompt stays cheap. */
    rerankMaxCandidates: Math.min(10, Math.max(1, parseInt(process.env.LLM_RERANK_MAX_CANDIDATES || "8", 10))),
    /** Below this, the answer is discarded and the deterministic path continues unchanged. */
    rerankMinConfidence: Math.min(1, Math.max(0, parseFloat(process.env.LLM_RERANK_MIN_CONFIDENCE || "0.6"))),
    /** A hung rerank must never hold up a recipe — on timeout the deterministic result stands. */
    rerankTimeoutMs: parseInt(process.env.LLM_RERANK_TIMEOUT_MS || "8000", 10),

    /**
     * The semantic candidate judge, deliberately a separate switch from rerankEnabled.
     *
     * ON by default, and safe to be: it is asked ONLY when the deterministic chain has already
     * finished and its answer is a fabricated estimate or nothing at all, while real records
     * survived every hard gate. An accepted database or recipe record is returned before a pool is
     * even built, and AMBIGUOUS/NONE/invalid/timeout all leave the existing outcome untouched — so
     * the worst case is the behaviour without it. Set LLM_JUDGE_ENABLED=false to return to the
     * purely deterministic chain; askJudge() then returns before touching the network, and
     * eligibility is still recorded in provenance as judgeTrigger.
     */
    judgeEnabled: (process.env.LLM_JUDGE_ENABLED || "true").toLowerCase() === "true",
    /** Defaults to the main model; separable so the judge can be evaluated independently. */
    judgeModel: process.env.LLM_JUDGE_MODEL || process.env.LLM_MODEL || "mistral-small-latest",
    /** Small on purpose: retrieval stays local and the prompt stays cheap. */
    judgeMaxCandidates: Math.min(20, Math.max(1, parseInt(process.env.LLM_JUDGE_MAX_CANDIDATES || "12", 10))),
    /** A hung judge must never hold up a recipe — on timeout the deterministic result stands. */
    judgeTimeoutMs: parseInt(process.env.LLM_JUDGE_TIMEOUT_MS || "8000", 10),
    /**
     * Below this a SELECTION is discarded and the deterministic outcome stands, on the same terms
     * and the same default as the reranker's. A bare "Öl" retrieves 37 gate-surviving records —
     * three specific oils, a beer, assorted others — and a model picking among them with low
     * stated confidence is guessing, not judging. Ambiguity is supposed to come back as AMBIGUOUS;
     * this catches the case where it comes back as a half-hearted pick instead.
     */
    judgeMinConfidence: Math.min(1, Math.max(0, parseFloat(process.env.LLM_JUDGE_MIN_CONFIDENCE || "0.6"))),
  },

  // USDA FoodData Central generic foods, bundled at resources/usda/usda-generic.sqlite (built by
  // scripts/import_usda.py; public domain / CC0). There is no API key and no network call: the
  // live search API was removed because its result window, not its data, was the defect.
  // USDA_LOCAL_DB_PATH overrides the bundled path, e.g. to point at a regenerated export without
  // a code change. Empty means "use the bundled default" (usda-local-provider.ts).
  usdaLocal: {
    dbPath: process.env.USDA_LOCAL_DB_PATH || "",
  },

  // BLS 4.0 Open Data (Max Rubner-Institut, CC BY 4.0) — bundled with this service at
  // resources/bls/bls-4.0.sqlite (built by scripts/import_bls.py; see README for attribution).
  // BLS_LOCAL_IMPORT_PATH overrides the bundled path, e.g. to point at a regenerated/updated
  // export without a code change. Empty means "use the bundled default" (bls-provider.ts).
  bls: {
    dbPath: process.env.BLS_LOCAL_IMPORT_PATH || "",
  },

  estimate: {
    strategy: (process.env.ESTIMATE_STRATEGY || "all") as "all" | "tagged",
    tag: process.env.ESTIMATE_TAG || "estimate",
  },

  // The user's own Mealie recipes as a source for homemade ingredients (a curry paste, a spice
  // mix). Conservative by construction — see mealie-recipe-provider.ts.
  mealieRecipeSource: {
    enabled: (process.env.MEALIE_RECIPE_SOURCE_ENABLED || "true").toLowerCase() === "true",
    /** How long the recipe-name index is reused before it is rebuilt. */
    indexTtlMs: parseInt(process.env.MEALIE_RECIPE_INDEX_TTL || "300", 10) * 1000,
    /** Maximum nesting of recipe-as-ingredient resolution. 1 = a recipe may use recipes, but those
     *  are read as stored and never resolved further. */
    maxDepth: Math.max(1, parseInt(process.env.MEALIE_RECIPE_MAX_DEPTH || "1", 10)),
  },

  cache: {
    dbPath: process.env.CACHE_DB_PATH || "data/cache.db",
    // Successful provider matches change rarely — cache them longest.
    matchTtlMs: parseInt(process.env.CACHE_MATCH_TTL || "604800", 10) * 1000, // 7 days
    // Negative results are retried sooner in case a provider gets better data over time.
    missTtlMs: parseInt(process.env.CACHE_MISS_TTL || "86400", 10) * 1000, // 1 day
    // LLM estimates (gram + nutrient fallback) are the least authoritative — shortest TTL.
    llmTtlMs: parseInt(process.env.CACHE_LLM_TTL || "43200", 10) * 1000, // 12 hours
  },

  logLevel: process.env.LOG_LEVEL || "info",
}

if (!hasAnyToken()) {
  throw new Error(
    "No Mealie API token configured. Set MEALIE_API_TOKEN or at least one MEALIE_API_TOKEN_<HOUSEHOLD_ID> environment variable.",
  )
}
