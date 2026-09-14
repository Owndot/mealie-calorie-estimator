import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    env: {
      MEALIE_API_TOKEN: "test-token",
      OFF_LANGUAGE: "de",
      CACHE_DB_PATH: "data/test-cache.db",
      // The real default (10/60s) is exercised deliberately in rate-limiter.test.ts; every other
      // test file shares one module-level limiter instance across all its tests, so a realistic
      // cap makes otherwise-unrelated tests flake/timeout purely on ordering once enough OFF/USDA
      // lookups accumulate within a file. Give normal tests headroom; only rate-limiter.test.ts
      // needs the real number, and it doesn't come close to exhausting even a generous limit.
      OFF_SEARCH_RATE_LIMIT: "1000",
      USDA_RATE_LIMIT: "1000",
    },
    reporters: ["default", ["junit", { outputFile: "test-results.xml" }]],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      reportsDirectory: "coverage",
    },
  },
})
