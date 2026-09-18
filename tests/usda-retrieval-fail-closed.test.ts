import { describe, it, expect, beforeAll, beforeEach } from "vitest"
import { config } from "../src/config.js"
import { initCache } from "../src/utils/cache.js"
import { buildResolverQuery } from "../src/services/resolver-query.js"
import { resolveNutrients } from "../src/services/nutrient-resolver.js"
import { usdaLocalProvider } from "../src/services/providers/usda-local-provider.js"
import { UNKNOWN_ATTRIBUTES } from "../src/types.js"

/**
 * USDA retrieval must fail CLOSED when it has no constrained query tokens.
 *
 * Found by the Paprika production audit of v1.0.3. `retrieve()` filtered query tokens to those
 * longer than two characters, then did `if (asked.length === 0) return records` — handing all
 * 8,262 rows to ranking. Scoring then answered a query that had asked for nothing, confidently:
 *
 *   "Ei" (German for egg) -> Sausage, Italian, pork, mild, cooked, pan-fried   322 kcal  conf 0.8
 *   "Zz"                  -> Cheese, mozzarella, low moisture, part-skim       298 kcal  conf 0.8
 *   "Aa"                  -> Milk, reduced fat, 2% milkfat                      50 kcal  conf 0.8
 *
 * Nothing downstream could catch it: no attribute was requested so none could go unmet, the core
 * gate compared against an empty core, and the sanity check asks whether numbers are possible —
 * not whether the food is the right one.
 */

async function resolve(foodName: string) {
  const { query, route } = buildResolverQuery(foodName, undefined, {})
  return resolveNutrients(query, route)
}

function usdaQuery(foodName: string, core: string | null) {
  const { query } = buildResolverQuery(foodName, undefined, {})
  return { ...query, coreFoodEnglish: core, attributes: UNKNOWN_ATTRIBUTES }
}

beforeAll(async () => {
  await initCache()
})

beforeEach(() => {
  config.llm.enabled = false
  config.llm.apiKey = ""
  config.llm.judgeEnabled = false
})

describe("an under-constrained query never reaches global USDA ranking", () => {
  it("'Ei' no longer resolves to an arbitrary USDA record", async () => {
    const resolved = await resolve("Ei")
    // It may legitimately stay unresolved deterministically, or be answered by another provider —
    // what it must never be is a confident USDA record chosen from an unconstrained scan.
    expect(resolved?.match.providerId).not.toBe("325658")
    // A curated recipe-vocabulary row is exempt: it names one reviewed record and never scans.
    // What stays forbidden is USDA answering from its own ranking for a query this short.
    if (resolved?.match.provider === "usda-local" && !resolved.match.matchReason?.startsWith("recipe-vocabulary:")) {
      throw new Error(`"Ei" still reached USDA by ranking: ${resolved.match.productName}`)
    }
  })

  it("nonsense two-letter strings resolve to nothing at all", async () => {
    for (const junk of ["Zz", "Aa", "Xy", "Qq"]) {
      const resolved = await resolve(junk)
      expect(resolved, `"${junk}" should not resolve to any food`).toBeNull()
    }
  })

  it("specifically: 'Zz' is not mozzarella and 'Aa' is not milk", async () => {
    expect((await resolve("Zz"))?.match.providerId).not.toBe("329370")
    expect((await resolve("Aa"))?.match.providerId).not.toBe("321359")
  })

  it("the USDA provider itself declines when it has no constrained tokens", async () => {
    // Directly at the provider, so the invariant is pinned even if the chain around it changes.
    for (const [name, core] of [["Ei", null], ["Zz", null], ["Aa", "aa"]] as const) {
      const match = await usdaLocalProvider.lookup(usdaQuery(name, core))
      expect(match, `USDA answered an unconstrained query "${name}"`).toBeNull()
    }
  })
})

describe("properly constrained queries are unaffected", () => {
  it("'black beans' still resolves to the real USDA record", async () => {
    const resolved = await resolve("black beans")
    expect(resolved).not.toBeNull()
    expect(resolved!.match.provider).toBe("usda-local")
    expect(resolved!.match.providerId).toBe("173734")
    expect(resolved!.match.productName).toContain("Beans, black")
  })

  it("other real USDA matches from the production corpus still work", async () => {
    const cumin = await resolve("Ground Cumin")
    expect(cumin!.match.provider).toBe("usda-local")
    expect(cumin!.match.productName).toContain("cumin")

    const onion = await resolve("Red Onion")
    expect(onion!.match.provider).toBe("usda-local")
    expect(onion!.match.productName).toContain("Onions")
  })

  it("BLS-first behaviour is unchanged", async () => {
    const cases: [string, string, string][] = [
      ["Kartoffeln", "bls", "K110100"],
      ["Olivenöl", "bls", "Q120000"],
      ["Hühnerei", "bls", "E111100"],
      ["Wasser", "bls", "N110000"],
    ]
    for (const [name, provider, id] of cases) {
      const r = await resolve(name)
      expect(r, `${name} should resolve`).not.toBeNull()
      expect(r!.match.provider).toBe(provider)
      expect(r!.match.providerId).toBe(id)
    }
  })
})
