import { describe, it, expect } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { config } from "../src/config.js"
import { overridesReady, initOverrides, countOverrides } from "../src/services/food-overrides.js"

/**
 * Guards the test suite's own isolation, so a run can never write to the persistent databases a
 * real deployment keeps.
 *
 * This exists because it already happened: with no `OVERRIDES_DB_PATH` set anywhere in the suite,
 * `tests/food-overrides.test.ts` wrote its fixtures into the repository's `data/overrides.db` —
 * the one file docs/OVERRIDES.md tells operators to back up because it cannot be reconstructed.
 * The stray row was even stamped `source: user-confirmed`, so nothing distinguished it from a
 * genuine binding.
 *
 * Asserting the resolved paths (rather than trusting the setup files ran) is what makes this a
 * guard: remove either setup file from vitest.config.ts and these tests fail.
 */

const PRODUCTION_DEFAULTS = ["data/overrides.db", "data/cache.db"]

function isUnderRepo(p: string): boolean {
  const repoRoot = path.resolve(__dirname, "..")
  return path.resolve(p).startsWith(repoRoot + path.sep)
}

describe("the test suite cannot touch production-shaped persistent databases", () => {
  it("the overrides database is not the production default", () => {
    expect(config.overrides.dbPath).not.toBe("data/overrides.db")
    for (const d of PRODUCTION_DEFAULTS) {
      expect(path.resolve(config.overrides.dbPath)).not.toBe(path.resolve(d))
    }
  })

  it("the overrides database lives in the OS temp directory, outside the repository", () => {
    const resolved = path.resolve(config.overrides.dbPath)
    expect(resolved.startsWith(path.resolve(os.tmpdir()))).toBe(true)
    expect(isUnderRepo(config.overrides.dbPath)).toBe(false)
  })

  it("the cache database is likewise isolated", () => {
    expect(config.cache.dbPath).not.toBe("data/cache.db")
    expect(path.resolve(config.cache.dbPath).startsWith(path.resolve(os.tmpdir()))).toBe(true)
    expect(isUnderRepo(config.cache.dbPath)).toBe(false)
  })

  it("each test file gets its own override database, not a shared one", () => {
    // The filename carries pid + a random uuid, which is what makes parallel files safe.
    expect(path.basename(config.overrides.dbPath)).toMatch(
      /^mealie-estimator-test-overrides-\d+-[0-9a-f-]{36}\.db$/,
    )
  })

  it("initialising and writing overrides does not create the repository default", async () => {
    const repoDefault = path.resolve(__dirname, "..", "data", "overrides.db")
    const before = fs.existsSync(repoDefault)
      ? fs.readFileSync(repoDefault).length
      : null

    await initOverrides()
    expect(overridesReady()).toBe(true)
    // A freshly isolated database starts empty — proof it is not the repo's populated one.
    expect(countOverrides()).toBe(0)

    const after = fs.existsSync(repoDefault) ? fs.readFileSync(repoDefault).length : null
    expect(after).toBe(before)
  })
})
