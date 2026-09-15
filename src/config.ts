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
    // Open Food Facts asks callers to identify themselves. The inherited default carried the
    // UPSTREAM maintainer's personal email, which would attribute this fork's traffic to someone
    // who did not write it; the project URL is an equally valid contact and is honest.
    userAgent: process.env.OFF_USER_AGENT || `mealie-nutrition-engine/${version} (+https://github.com/Owndot/mealie-nutrition-engine)`,
  },

  llm: {
    enabled: (process.env.LLM_ENABLED || "false").toLowerCase() === "true",
    baseUrl: process.env.LLM_BASE_URL || "https://api.mistral.ai/v1",
    endpointUrl: process.env.LLM_ENDPOINT_URL || "/chat/completions",
    apiKey: process.env.LLM_API_KEY || "",
    model: process.env.LLM_MODEL || "mistral-small-latest",
    rateLimit: parseInt(process.env.LLM_RATE_LIMIT || "30", 10),
  },

  // USDA FoodData Central — optional generic-route fallback provider. Only wired into the
  // provider registry when USDA_API_KEY is set; there is no dummy/placeholder provider when
  // it's absent, the generic chain simply has one fewer provider.
  usda: {
    apiKey: process.env.USDA_API_KEY || "",
    baseUrl: process.env.USDA_BASE_URL || "https://api.nal.usda.gov/fdc/v1",
    rateLimit: parseInt(process.env.USDA_RATE_LIMIT || "10", 10),
    maxRetries: parseInt(process.env.USDA_MAX_RETRIES || "3", 10),
    retryBackoffMs: parseInt(process.env.USDA_RETRY_BACKOFF_MS || "500", 10),
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
