import { afterAll } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"

/**
 * Gives every test FILE its own persistent-cache database.
 *
 * Previously all test files shared one `data/test-cache.db` (pinned in vitest.config.ts) while
 * Vitest runs files in parallel, and `tests/cache.test.ts` additionally deleted that exact file in
 * its own beforeAll/afterAll — so one file could unlink the database out from under another that
 * was mid-run, and every file inherited whatever rows previous runs had left behind. That made
 * the suite order- and history-dependent: a full run was observed failing 6 tests purely because
 * an earlier run had populated the shared cache, then passing again once the file was removed.
 * Test outcomes must not depend on other files or on prior runs.
 *
 * Deliberately imports nothing from src/: setup files run before the test file is imported, and
 * src/config.ts reads CACHE_DB_PATH at import time, so this must not pull config.ts in early.
 */
const dbPath = path.join(os.tmpdir(), `mealie-estimator-test-cache-${process.pid}-${randomUUID()}.db`)
process.env.CACHE_DB_PATH = dbPath

afterAll(() => {
  try {
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath)
  } catch {
    // Best effort — a leftover file in the OS temp dir is harmless and never reused (random name).
  }
})
