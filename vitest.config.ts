import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    // Per-FILE isolation of BOTH persistent databases. CACHE_DB_PATH and OVERRIDES_DB_PATH are
    // deliberately NOT set here: a single static path is shared by every file (which Vitest runs
    // in parallel), which made the suite order- and history-dependent. Each setup file instead
    // derives its own path and must set the variable before src/config.ts is imported, since
    // config.ts reads both at import time. See tests/setup/isolated-cache.ts and
    // tests/setup/isolated-overrides.ts; tests/setup-isolation.test.ts fails if either is removed.
    setupFiles: ["./tests/setup/isolated-cache.ts", "./tests/setup/isolated-overrides.ts"],
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
    // vitest's 5s default is too tight for the suites that drive the REAL bundled BLS database:
    // whichever test touches it first pays a one-time load of a 2 MB SQLite file plus tokenizing
    // 7,140 names. That fits locally and did not on a slower CI runner, which failed the build on
    // timing rather than on any assertion. Raised rather than mocked — these tests are valuable
    // precisely because they run against the real data.
    testTimeout: 20000,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      reportsDirectory: "coverage",
    },
  },
})
