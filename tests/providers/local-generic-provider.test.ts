import { describe, it, expect } from "vitest"
import { localGenericProvider } from "../../src/services/providers/local-generic-provider.js"

function query(foodName: string, brand: string | null = null) {
  return { foodName, brand, category: null, state: "unknown" as const }
}

describe("LocalGenericProvider", () => {
  it("resolves a known generic food (German name)", async () => {
    const match = await localGenericProvider.lookup(query("Mehl"))
    expect(match?.nutrients.kcalPer100g).toBe(364)
    expect(match?.provider).toBe("local-generic")
  })

  it("resolves a known generic food (English alias)", async () => {
    const match = await localGenericProvider.lookup(query("flour"))
    expect(match?.nutrients.kcalPer100g).toBe(364)
  })

  it("matches via word-boundary containment for a descriptive phrase", async () => {
    const match = await localGenericProvider.lookup(query("frische Petersilie"))
    expect(match?.canonicalName).toBe("Petersilie")
  })

  it("returns null for an unrecognized food", async () => {
    const match = await localGenericProvider.lookup(query("xyzzy-unknown-food-item"))
    expect(match).toBeNull()
  })

  it("never returns a brand — this provider only ever serves generic entries", async () => {
    const match = await localGenericProvider.lookup(query("Butter"))
    expect(match?.brand).toBeNull()
  })

  it("does not match a short generic alias against an unrelated longer word (Ei vs Eier vs unrelated)", async () => {
    const match = await localGenericProvider.lookup(query("Einkaufsliste"))
    expect(match).toBeNull()
  })
})
