import { describe, it, expect, vi, beforeEach } from "vitest"
import Fastify from "fastify"

const pipelineCalls: { slug: string; opts: unknown }[] = []

vi.mock("../../src/services/pipeline.js", () => ({
  runEstimationPipeline: vi.fn(async (slug: string, opts: unknown = {}) => {
    pipelineCalls.push({ slug, opts })
    return { status: "no-op" }
  }),
}))

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

describe("webhookRoutes", () => {
  beforeEach(() => {
    pipelineCalls.length = 0
  })

  it("accepts a valid recipe-updated event and dispatches the pipeline for the right slug", async () => {
    const { webhookRoutes } = await import("../../src/routes/webhook.js")
    const app = Fastify()
    await app.register(webhookRoutes)

    const documentData = encodeURIComponent(JSON.stringify({ document_type: "recipe", operation: "update", recipe_slug: "my-recipe" }))
    const res = await app.inject({ method: "POST", url: "/webhook", payload: { title: "t", body: "b", event_type: "recipe.update", document_data: documentData } })

    expect(res.statusCode).toBe(202)
    await flush()
    expect(pipelineCalls).toEqual([{ slug: "my-recipe", opts: {} }])
  })

  it("rejects a payload missing document_data", async () => {
    const { webhookRoutes } = await import("../../src/routes/webhook.js")
    const app = Fastify()
    await app.register(webhookRoutes)

    const res = await app.inject({ method: "POST", url: "/webhook", payload: { title: "t", body: "b", event_type: "x" } })
    expect(res.statusCode).toBe(400)
  })

  it("rejects invalid JSON in document_data", async () => {
    const { webhookRoutes } = await import("../../src/routes/webhook.js")
    const app = Fastify()
    await app.register(webhookRoutes)

    const res = await app.inject({ method: "POST", url: "/webhook", payload: { title: "t", body: "b", event_type: "x", document_data: "not-json-%%" } })
    expect(res.statusCode).toBe(400)
  })

  it("skips non-recipe document types without invoking the pipeline", async () => {
    const { webhookRoutes } = await import("../../src/routes/webhook.js")
    const app = Fastify()
    await app.register(webhookRoutes)

    const documentData = encodeURIComponent(JSON.stringify({ document_type: "cookbook", operation: "update", recipe_slug: "irrelevant" }))
    const res = await app.inject({ method: "POST", url: "/webhook", payload: { title: "t", body: "b", event_type: "x", document_data: documentData } })

    expect(res.statusCode).toBe(200)
    await flush()
    expect(pipelineCalls).toHaveLength(0)
  })

  it("never passes force or overrideManual — a webhook must always be able to settle to a no-op", async () => {
    const { webhookRoutes } = await import("../../src/routes/webhook.js")
    const { runEstimationPipeline } = await import("../../src/services/pipeline.js")
    const app = Fastify()
    await app.register(webhookRoutes)

    const documentData = encodeURIComponent(JSON.stringify({ document_type: "recipe", operation: "update", recipe_slug: "loop-test" }))
    await app.inject({ method: "POST", url: "/webhook", payload: { title: "t", body: "b", event_type: "x", document_data: documentData } })
    await flush()

    const lastCall = (runEstimationPipeline as any).mock.calls.at(-1)
    expect(lastCall).toEqual(["loop-test"]) // called with slug only, no options object
  })
})
