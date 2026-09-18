import { describe, it, expect, beforeAll } from "vitest"
import { initCache } from "../src/utils/cache.js"
import { estimateRecipe } from "../src/services/estimator.js"
import type { MealieRecipe } from "../src/types.js"

/**
 * A colour or leaf-shape adjective belonged to neither of the two curated modifier categories, so
 * the scorer read it as CONTENT — as if it named a second food. That did not merely dilute a
 * score, it redirected retrieval: on v1.1.0 "rote Linsen" ranked "Rote Rübe/Rote Bete" top at 31,
 * the lentil records did not place at all, nothing cleared the acceptance floor, and the whole
 * recipe was withheld. "Linsen" alone reached "Linse reif" at 75.
 *
 * The failure was safe — beetroot was never served as lentils — but it made a common adjective
 * enough to lose a recipe's nutrition entirely, which deterministic mode cannot afford.
 *
 * Both halves matter and both are tested here: a generic qualifier must stop hiding the base food,
 * and a modifier that carries identity, state or nutrition must still mean what it says.
 */

function oneIngredient(name: string): MealieRecipe {
  return {
    slug: "modifier-test", name: "modifier-test", recipeYield: null, recipeServings: 1,
    recipeIngredient: [{
      quantity: 100,
      unit: { id: "g", name: "g", pluralName: "g", abbreviation: null, standardQuantity: null, standardUnit: null },
      food: { id: name, name, pluralName: null, aliases: [] },
      note: null, display: `100 g ${name}`, title: null, originalText: `100 g ${name}`,
    }],
    nutrition: null, tags: [], extras: {}, householdId: null,
  }
}

async function resolve(name: string): Promise<{ id: string | null; product: string | null; completeness: string }> {
  const r = await estimateRecipe(oneIngredient(name))
  const m = r.matchedIngredients?.[0]
  return { id: m?.providerId ?? null, product: m?.productName ?? null, completeness: r.completeness }
}

beforeAll(async () => { await initCache() })

describe("a generic qualifier no longer hides the base food", () => {
  // Each pair: the bare food, and the same food behind a colour or shape adjective. The modified
  // form must reach the same identity — not be withheld for carrying an adjective.
  const pairs: [string, string][] = [
    ["Linsen", "rote Linsen"],
    ["Zwiebel", "rote Zwiebel"],
    ["Champignons", "braune Champignons"],
    ["Olivenöl", "natives Olivenöl"],
    ["Petersilie", "glatte Petersilie"],
  ]

  for (const [base, modified] of pairs) {
    it(`${modified} resolves to the same record as ${base}`, async () => {
      const b = await resolve(base)
      const m = await resolve(modified)

      expect(b.id, `${base} must resolve for this pair to mean anything`).not.toBeNull()
      expect(m.id, `${modified} resolved to ${m.product}`).toBe(b.id)
      expect(m.completeness).not.toBe("withheld")
    })
  }
})

describe("modifiers that carry identity, state or nutrition still mean what they say", () => {
  // The point of the change is that ONE class of adjective stopped being read as food content.
  // Everything that genuinely changes the food must still separate it from its base record.
  const mustNotCollapse: [string, string][] = [
    ["Tomaten", "getrocknete Tomaten"],     // preservation: ~22 vs ~276 kcal/100 g
    ["Kartoffeln", "gekochte Kartoffeln"],  // preparation
    ["Paprika", "Paprikapulver"],           // form: vegetable vs ground spice
  ]

  for (const [base, modified] of mustNotCollapse) {
    it(`${modified} does not silently become ${base}`, async () => {
      const b = await resolve(base)
      const m = await resolve(modified)

      expect(b.id, `${base} must resolve`).not.toBeNull()
      // Either it finds the genuinely different record, or it declines. What it must never do is
      // quietly hand back the untransformed food.
      expect(m.id, `${modified} collapsed onto the base record ${b.product}`).not.toBe(b.id)
    })
  }

  it("a fat-class modifier is still a different food from the plain one", async () => {
    // "fettarm" is an IDENTITY_MODIFIER and is untouched by this change.
    const { IDENTITY_MODIFIERS } = await import("../src/services/providers/food-semantics.js")
    expect(IDENTITY_MODIFIERS.has("fettarm")).toBe(true)
    expect(IDENTITY_MODIFIERS.has("vollmilch")).toBe(true)
  })

  it("state and preparation words are not in the generic-qualifier class", async () => {
    const { GERMAN_DESCRIPTOR_WORDS, IDENTITY_MODIFIERS } =
      await import("../src/services/providers/food-semantics.js")
    // Colours live in their own list and are never consulted by the scorer, so category A is
    // untouched. What matters is that the attribute markers still read the words that matter.
    const { inferAttributesFromName } = await import("../src/services/providers/food-semantics.js")
    expect(inferAttributesFromName("getrocknete Tomaten").preservation).toBe("dried")
    expect(inferAttributesFromName("Paprikapulver").form).toBe("powder")
    expect(GERMAN_DESCRIPTOR_WORDS.has("getrocknet")).toBe(true)
    expect(IDENTITY_MODIFIERS.has("getrocknet")).toBe(false)
  })
})

describe("the qualifier class stays bounded", () => {
  it("covers colours and leaf shape in the inflected forms the tokenizer emits", async () => {
    const { isGenericQualifier } = await import("../src/services/providers/food-semantics.js")
    // Umlauts are transliterated before a token reaches this check (ü -> ue).
    for (const w of ["rot", "rote", "roter", "gruen", "gruene", "gruenes",
                     "braun", "braune", "glatt", "glatte", "nativ", "natives"]) {
      expect(isGenericQualifier(w), w).toBe(true)
    }
  })

  it("colours that name a VARIETY are excluded, so a better provider is never preempted", async () => {
    const { isGenericQualifier } = await import("../src/services/providers/food-semantics.js")
    // "Schwarze Bohne" must keep reaching USDA's black-bean record; dropping the colour sent it
    // to a green bean instead. "orange" is out because in German it is also the fruit.
    for (const w of ["schwarz", "schwarze", "weiss", "weisse", "orange"]) {
      expect(isGenericQualifier(w), w).toBe(false)
    }
  })
})

describe("the Paprika fix from the previous change still holds", () => {
  it("a vegetable form now reaches the vegetable rather than being withheld", async () => {
    // With the qualifier no longer read as content, BLS answers first and USDA's 282 kcal spice
    // is never consulted — the safe refusal becomes a correct answer.
    const r = await resolve("rote Paprika")
    expect(r.id).not.toBe("171329")
    expect(r.product).toMatch(/Gemüsepaprika/i)
  })

  it("a spice form still reaches the spice", async () => {
    const r = await resolve("Paprika rosenscharf")
    expect(r.id).toBe("171329")
  })
})
