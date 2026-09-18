import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { loadVocabularyDirectory, __resetVocabularyForTests } from "../src/services/vocabulary/recipe-vocabulary.js"

import { buildResolverQuery } from "../src/services/resolver-query.js"

const directories: string[] = []
afterEach(() => { __resetVocabularyForTests(); for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })

function load(de: unknown[], en: unknown[] = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "recipe-vocabulary-"))
  directories.push(dir)
  for (const [language, entries] of [["de", de], ["en", en]]) {
    fs.writeFileSync(path.join(dir, `${language}.json`), JSON.stringify({ version: 1, language, entries }))
  }
  return loadVocabularyDirectory(dir)
}
const row = { alias: "Test", normalizedAlias: "test", language: "de", kind: "synonym", identity: "Test" }

describe("strict runtime vocabulary attributes", () => {
  it.each(["fat", "packedIn", "type", "colour", "carbonated", "style", "futureAxis"])("rejects unsupported key %s instead of silently ignoring it", (key) => {
    expect(load([{ ...row, attributes: { [key]: "value" } }]).size).toBe(0)
  })
  it.each([
    { state: "roasted" }, { state: ["raw"] }, { form: "liquid" }, { preservation: "pickled" },
    { fatPercent: "15" }, { fatPercent: -1 }, { fatPercent: 101 }, [], null, "fresh",
  ])("rejects malformed attributes %j", (attributes) => {
    expect(load([{ ...row, attributes }]).size).toBe(0)
  })
  it("accepts exactly the supported axes", () => {
    expect(load([{ ...row, attributes: { state: "cooked", form: "paste", preservation: "canned", fatPercent: 15 } }]).size).toBe(1)
  })
})

describe("global alias collisions", () => {
  it.each(["different identity", "Test"])("rejects both languages even when the second identity is %s", (identity) => {
    const index = load([row], [{ ...row, language: "en", identity }])
    expect(index.size).toBe(0)
  })
  it("compares normalized aliases rather than spellings and preserves unrelated rows", () => {
    const index = load([row, { ...row, alias: "Other", normalizedAlias: "other" }], [
      { ...row, alias: "TEST!", language: "en", preferred: { provider: "bls", id: "different" } },
      { ...row, language: "en" },
    ])
    expect([...index.keys()]).toEqual(["de:other"])
  })
})

// The declared numeric axis must actually reach the resolver, not just pass validation.
it("applies a validated fat percentage to the resolver query", () => {
  __resetVocabularyForTests(load([{ ...row, attributes: { fatPercent: 15 } }]))
  expect(buildResolverQuery("Test", undefined).query.attributes?.fatPercent).toBe(15)
})
