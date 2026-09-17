import { afterAll } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"

/**
 * Gives every test FILE its own user-override database.
 *
 * `config.ts` defaults `OVERRIDES_DB_PATH` to `data/overrides.db` — the real, production-shaped
 * path. Nothing in the suite set that variable, so `tests/food-overrides.test.ts` wrote its
 * fixtures straight into the repository's own overrides database, leaving rows marked
 * `source: user-confirmed` that are indistinguishable from a genuine operator binding. That file
 * is the one piece of state docs/OVERRIDES.md tells operators to back up, because it cannot be
 * reconstructed; a test run must never touch it.
 *
 * It also silently changed the resolution chain for every later local run — including benchmark
 * runs whose stated configuration was "no overrides". That happened to be harmless (the stray
 * binding never matched the corpus), but nothing guaranteed it.
 *
 * Isolating here rather than inside the override tests is deliberate: it holds for EVERY test
 * file, including any future one that reaches the override provider indirectly through the
 * resolver chain, so the default path cannot be reintroduced by accident.
 *
 * Deliberately imports nothing from src/: setup files run before the test file is imported, and
 * src/config.ts reads OVERRIDES_DB_PATH at import time, so this must not pull config.ts in early.
 * Mirrors tests/setup/isolated-cache.ts.
 */
const dbPath = path.join(os.tmpdir(), `mealie-estimator-test-overrides-${process.pid}-${randomUUID()}.db`)
process.env.OVERRIDES_DB_PATH = dbPath

afterAll(() => {
  try {
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath)
  } catch {
    // Best effort — a leftover file in the OS temp dir is harmless and never reused (random name).
  }
})
