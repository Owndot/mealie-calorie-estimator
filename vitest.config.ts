import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    // Per-FILE cache isolation. CACHE_DB_PATH is deliberately NOT set here: a single static path
    // is shared by every file (which Vitest runs in parallel), which made the suite order- and
    // history-dependent. See tests/setup/isolated-cache.ts.
    setupFiles: ["./tests/setup/isolated-cache.ts"],
    env: {
      MEALIE_API_TOKEN: "test-token",
      OFF_LANGUAGE: "de",
      // The real default (10/60s) is exercised deliberately in rate-limiter.test.ts; every other
      // test file shares one module-level limiter instance across all its tests, so a realistic
      // cap makes otherwise-unrelated tests flake/timeout purely on ordering once enough OFF/USDA
      // lookups accumulate within a file. Give normal tests headroom; only rate-limiter.test.ts
      // needs the real number, and it doesn't come close to exhausting even a generous limit.
      OFF_SEARCH_RATE_LIMIT: "1000",
      USDA_RATE_LIMIT: "1000",
      // Same reasoning as the two above — it was simply never hit before. The limiter is built
      // once at module import from this value, so it cannot be raised per-test at runtime: once
      // llm-normalizer.test.ts grew past the real 30/60s default, later tests in the file sat in
      // waitForRateLimit's 1s sleep loop and timed out on ordering alone.
      LLM_RATE_LIMIT: "1000",
    },
    reporters: ["default", ["junit", { outputFile: "test-results.xml" }]],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      reportsDirectory: "coverage",
    },
  },
})
