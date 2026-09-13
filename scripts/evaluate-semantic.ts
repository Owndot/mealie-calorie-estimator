// Optional live classifier evaluation; uses the configured provider and incurs its normal API usage.
// Run: npx tsx scripts/evaluate-semantic.ts
import fs from "node:fs"
import { config } from "../src/config.js"
import { initCache } from "../src/utils/cache.js"
import { interpretSemanticIngredient } from "../src/services/ingredient-interpreter.js"
import { matchGenericFood } from "../src/services/generic-foods.js"
import type { MealieIngredient } from "../src/types.js"

if (!config.llm.enabled || !config.llm.apiKey) throw new Error("Live evaluation requires the existing LLM configuration to be enabled")
await initCache()
const fixtures = JSON.parse(fs.readFileSync(new URL("../tests/fixtures/german-ingredients.json", import.meta.url), "utf8")) as string[][]
let passed = 0
for (const [name, food, state] of fixtures) {
  const ingredient: MealieIngredient = { quantity: 100, food: { id: "", name, pluralName: null, aliases: [] },
    unit: { id: "", name: "g", abbreviation: null, pluralName: null, standardQuantity: null, standardUnit: null },
    note: null, display: name, originalText: null, title: null }
  const interpreted = await interpretSemanticIngredient(ingredient)
  const match = interpreted && matchGenericFood(interpreted)
  const expected = `${food === "basmati rice" ? "rice" : food}:${state}`
  if (match?.key === expected) passed++
  else console.log(JSON.stringify({ name, expected, actual: match?.key ?? null, interpretation: interpreted }))
}
console.log(`${passed}/${fixtures.length} live interpretation matches (valid cached classifications may be reused)`)
process.exitCode = passed === fixtures.length ? 0 : 1
