import { describe, it, expect, vi, beforeEach } from "vitest"
import Fastify from "fastify"

const pipelineCalls: { slug: string; opts: unknown }[] = []

vi.mock("../../src/services/pipeline.js", () => ({
  runEstimationPipeline: vi.fn(async (slug: string, opts: unknown = {}) => {
    pipelineCalls.push({ slug, opts })
    return { status: "estimated", calories: 100, tagSlugs: [], completeness: "complete" }
  }),
}))

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

describe("estimateRoutes — POST /estimate/:slug", () => {
  beforeEach(() => {
    pipelineCalls.length = 0
  })

  it("accepts the request and dispatches the pipeline for the given slug with force=false by default", async () => {
    const { estimateRoutes } = await import("../../src/routes/estimate.js")
    const app = Fastify()
    await app.register(estimateRoutes)

    const res = await app.inject({ method: "POST", url: "/estimate/my-recipe" })
    expect(res.statusCode).toBe(202)

    await flush()
    expect(pipelineCalls).toEqual([{ slug: "my-recipe", opts: { force: false, overrideManual: false } }])
  })

  it("passes force=true from the query string", async () => {
    const { estimateRoutes } = await import("../../src/routes/estimate.js")
    const app = Fastify()
    await app.register(estimateRoutes)

    await app.inject({ method: "POST", url: "/estimate/my-recipe?force=true" })
    await flush()

    expect(pipelineCalls[0].opts).toEqual({ force: true, overrideManual: false })
  })

  it("passes overrideManual=true only when explicitly requested alongside force", async () => {
    const { estimateRoutes } = await import("../../src/routes/estimate.js")
    const app = Fastify()
    await app.register(estimateRoutes)

    await app.inject({ method: "POST", url: "/estimate/my-recipe?force=true&overrideManual=true" })
    await flush()

    expect(pipelineCalls[0].opts).toEqual({ force: true, overrideManual: true })
  })
})
