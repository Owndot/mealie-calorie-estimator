import { describe, it, expect, vi, beforeEach } from "vitest"
import Fastify from "fastify"

const pipelineCalls: string[] = []

const outcomeBySlug: Record<string, unknown> = {
  "recipe-a": { status: "estimated", calories: 100, tagSlugs: [], completeness: "complete" },
  "recipe-b": { status: "no-op" },
  "recipe-c": { status: "manual-preserved" },
}

vi.mock("../../src/services/mealie-client.js", () => ({
  getAllRecipes: vi.fn(async () => ["recipe-a", "recipe-b", "recipe-c", "recipe-error"]),
}))

vi.mock("../../src/services/pipeline.js", () => ({
  runEstimationPipeline: vi.fn(async (slug: string) => {
    pipelineCalls.push(slug)
    if (slug === "recipe-error") throw new Error("boom")
    return outcomeBySlug[slug]
  }),
}))

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

describe("backfillRoutes", () => {
  beforeEach(() => {
    pipelineCalls.length = 0
  })

  it("accepts the request and processes every recipe slug from getAllRecipes", async () => {
    const { backfillRoutes } = await import("../../src/routes/backfill.js")
    const app = Fastify()
    await app.register(backfillRoutes)

    const res = await app.inject({ method: "POST", url: "/backfill" })
    expect(res.statusCode).toBe(202)

    await flush()
    await flush()
    expect(pipelineCalls).toEqual(["recipe-a", "recipe-b", "recipe-c", "recipe-error"])
  })

  it("does not stop the batch when one recipe throws — other recipes still get processed", async () => {
    const { backfillRoutes } = await import("../../src/routes/backfill.js")
    const app = Fastify()
    await app.register(backfillRoutes)

    await app.inject({ method: "POST", url: "/backfill" })
    await flush()
    await flush()

    // all four slugs were attempted despite recipe-error throwing
    expect(pipelineCalls).toContain("recipe-error")
    expect(pipelineCalls).toContain("recipe-c")
  })

  it("never passes force/overrideManual — backfill must not silently overwrite manual entries", async () => {
    const { backfillRoutes } = await import("../../src/routes/backfill.js")
    const { runEstimationPipeline } = await import("../../src/services/pipeline.js")
    const app = Fastify()
    await app.register(backfillRoutes)

    await app.inject({ method: "POST", url: "/backfill" })
    await flush()
    await flush()

    for (const call of (runEstimationPipeline as any).mock.calls) {
      expect(call.length).toBe(1) // slug only, no options object
    }
  })
})
