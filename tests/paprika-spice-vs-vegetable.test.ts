import { describe, it, expect, beforeAll } from "vitest"
import { initCache } from "../src/utils/cache.js"
import { inferAttributesFromName } from "../src/services/providers/food-semantics.js"
import { estimateRecipe } from "../src/services/estimator.js"
import type { MealieRecipe } from "../src/types.js"

/**
 * German "Paprika" is the bell pepper, ~20-38 kcal/100 g. English "paprika" is the ground dried
 * spice, 282. USDA holds exactly ONE record containing the token — "Spices, paprika" — and files
 * the vegetable as "Peppers, sweet, red, raw", which shares no token with the German phrase.
 *
 * So on v1.1.0, deterministic "rote Paprika" and "grüne Paprika" both resolved to the 282 kcal
 * spice: a ~10x error on an ingredient measured in vegetable quantities. No ranking, attribute or
 * rerank rule could have saved it, because the right record is not reachable from the German words
 * at all. The only safe deterministic answer is to refuse the wrong one and leave it unresolved —
 * a withheld ingredient is recoverable, a silently wrong one is not.
 *
 * These run with the LLM disabled on purpose: deterministic mode must be safe without it.
 */

function oneIngredient(name: string): MealieRecipe {
  return {
    slug: "paprika-test", name: "paprika-test", recipeYield: null, recipeServings: 1,
    recipeIngredient: [{
      quantity: 100,
      unit: { id: "g", name: "g", pluralName: "g", abbreviation: null, standardQuantity: null, standardUnit: null },
      food: { id: name, name, pluralName: null, aliases: [] },
      note: null, display: `100 g ${name}`, title: null, originalText: `100 g ${name}`,
    }],
    nutrition: null, tags: [], extras: {}, householdId: null,
  }
}

async function resolve(name: string): Promise<{ id: string | null; product: string | null; kcal: number | null }> {
  const r = await estimateRecipe(oneIngredient(name))
  const m = r.matchedIngredients?.[0]
  return {
    id: m?.providerId ?? null,
    product: m?.productName ?? null,
    kcal: m?.nutrients?.kcalPer100g ?? null,
  }
}

/** The record this whole test file exists to keep away from vegetable quantities. */
const SPICE = "171329"

beforeAll(async () => { await initCache() })

describe("the spice record is recognisable as a dried preparation", () => {
  it("USDA's spice category states a preservation its name never spells out", () => {
    // "Spices, paprika" carries no preparation WORD, so both sides looked attribute-free and
    // nothing could tell a dried spice from a fresh vegetable.
    expect(inferAttributesFromName("Spices, paprika").preservation).toBe("dried")
    expect(inferAttributesFromName("Spices, cardamom").preservation).toBe("dried")
  })

  it("a name carrying its own marker keeps it — the category only fills a gap", () => {
    expect(inferAttributesFromName("Spices, cumin seed").form).toBe("seed")
    expect(inferAttributesFromName("Spices, coriander leaf, dried").form).toBe("leaf")
    expect(inferAttributesFromName("Spices, ginger, ground").form).toBe("ground")
  })
})

describe("vegetable forms never resolve to the spice", () => {
  for (const name of ["rote Paprika", "grüne Paprika", "gelbe Paprika", "Paprikaschote"]) {
    it(`${name} does not take the 282 kcal spice record`, async () => {
      const r = await resolve(name)
      expect(r.id, `${name} resolved to ${r.product}`).not.toBe(SPICE)
      // Withheld is the accepted outcome here: the vegetable record is not reachable from these
      // German words, and refusing is correct. What must never happen is a spice-density answer.
      if (r.kcal !== null) expect(r.kcal).toBeLessThan(100)
    })
  }

  it("reads them as fresh produce rather than as an unqualified word", () => {
    for (const name of ["rote Paprika", "Paprikaschote", "Paprika"]) {
      expect(inferAttributesFromName(name).preservation, name).toBe("fresh")
    }
  })
})

describe("spice forms still reach the spice", () => {
  for (const name of ["Paprika rosenscharf", "Smoked Paprika", "geräucherte Paprika"]) {
    it(`${name} resolves to the dried spice`, async () => {
      const r = await resolve(name)
      expect(r.id, `${name} resolved to ${r.product}`).toBe(SPICE)
      expect(r.kcal).toBeGreaterThan(200)
    })
  }

  it("the grade words carry the form by themselves", () => {
    // "rosenscharf" and "edelsüß" name a grade of ground paprika and appear on nothing else.
    expect(inferAttributesFromName("Paprika rosenscharf").form).toBe("powder")
    expect(inferAttributesFromName("Paprikapulver (edelsüß)").form).toBe("powder")
    expect(inferAttributesFromName("Paprikapulver").form).toBe("powder")
  })

  it("a stated powder is never read as fresh produce", () => {
    for (const name of ["Paprikapulver", "Paprika rosenscharf", "Paprikapulver (edelsüß)"]) {
      expect(inferAttributesFromName(name).preservation, name).not.toBe("fresh")
    }
  })
})

describe("the bare word keeps its established behaviour", () => {
  it("resolves to the vegetable, as it did before", async () => {
    const r = await resolve("Paprika")
    expect(r.id).toBe("G541100")
    expect(r.kcal!).toBeLessThan(100)
  })
})

describe("nothing else is dragged along", () => {
  it("smoking is not turned into a form, so smoked whole foods are untouched", async () => {
    // "geräuchert" also describes salmon, ham and sausage. It is read only as a reason the
    // false-friend rule does not apply, never as evidence of a powder.
    expect(inferAttributesFromName("Lachs geräuchert").form).toBe("unknown")
    const r = await resolve("Lachs geräuchert")
    expect(r.product).toMatch(/Lachs/i)
  })

  it("an English spice query is unaffected", async () => {
    const r = await resolve("Ground Cumin")
    expect(r.id).toBe("170923")
    expect(r.kcal).toBeGreaterThan(300)
  })

  it("fresh ginger still reaches the fresh root, not a ground spice", async () => {
    const r = await resolve("Ingwer")
    expect(r.product).toMatch(/Ingwer/i)
    expect(r.kcal!).toBeLessThan(100)
  })
})
