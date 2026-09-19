import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import Fastify from "fastify"
import { config } from "../src/config.js"
import { EstimationQueue } from "../src/services/estimation-queue.js"
import { estimateRoutes } from "../src/routes/estimate.js"
import { webhookRoutes } from "../src/routes/webhook.js"
import { runEstimationPipeline } from "../src/services/pipeline.js"
import { getRecipe, patchRecipe } from "../src/services/mealie-client.js"
import { estimateAndTag } from "../src/services/tagging.js"
import type { MealieRecipe } from "../src/types.js"

vi.mock("../src/services/mealie-client.js", () => ({
  getRecipe: vi.fn(), getRecipeHouseholdId: () => null, patchRecipe: vi.fn(),
}))
vi.mock("../src/services/tagging.js", () => ({
  estimateAndTag: vi.fn(), tagsAreComplete: () => true,
  perServingFromRecipeNutrition: vi.fn(), resolveAndMergeTags: vi.fn(),
}))

function deferred() {
  let resolve!: () => void
  let reject!: (err: Error) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve))
const recipe = (slug: string): MealieRecipe => ({
  slug, name: slug, recipeYield: null, recipeServings: 1, recipeIngredient: [],
  nutrition: null, tags: [], extras: {},
})
let gates: ReturnType<typeof deferred>[]
let active: number
let peak: number
let started: string[]
let finished: string[]

beforeEach(() => {
  gates = []; started = []; finished = []; active = 0; peak = 0
  vi.mocked(getRecipe).mockReset().mockImplementation(async (slug) => recipe(slug))
  vi.mocked(patchRecipe).mockReset().mockResolvedValue(undefined)
  vi.mocked(estimateAndTag).mockReset().mockImplementation(async (r) => {
    const gate = deferred()
    gates.push(gate)
    started.push(r.slug)
    active++
    peak = Math.max(peak, active)
    try {
      // Represents a provider request followed by Mealie writeback, both inside the slot.
      await gate.promise
      await patchRecipe(r.slug, { extras: { fixture: "written" } })
      finished.push(r.slug)
      return { calories: 100, tagSlugs: [], completeness: "complete" }
    } finally {
      active--
    }
  })
})
afterEach(async () => {
  // Drain even when an assertion fails, so a failed test cannot poison the next one.
  for (let i = 0; i < gates.length; i++) { gates[i].resolve(); await flush() }
})

describe("shared estimation pipeline concurrency", () => {
  it("accepts 19 simultaneous HTTP requests and bounds provider work and reads until all execute", async () => {
    const app = Fastify()
    await app.register(estimateRoutes)
    try {
      expect(config.estimate.concurrency).toBe(2)
      const responses = await Promise.all(Array.from({ length: 19 }, (_, i) =>
        app.inject({ method: "POST", url: `/estimate/recipe-${i}?force=true` })))
      expect(responses.every((r) => r.statusCode === 202 && r.json().status === "accepted")).toBe(true)
      await flush()
      expect(started).toEqual(["recipe-0", "recipe-1"])
      expect(getRecipe).toHaveBeenCalledTimes(2)
      for (let i = 0; i < 19; i++) {
        expect(gates[i]).toBeDefined()
        gates[i].resolve()
        await flush()
      }
      expect(finished).toHaveLength(19)
      expect(patchRecipe).toHaveBeenCalledTimes(19)
      expect(peak).toBe(2)
      expect(active).toBe(0)
    } finally { await app.close() }
  })

  it("isolates provider and write failures and releases slots for queued recipes", async () => {
    vi.mocked(patchRecipe).mockRejectedValueOnce(new Error("socket hang up"))
    const promises = ["provider-fails", "write-fails", "succeeds", "also-succeeds"].map((slug) =>
      runEstimationPipeline(slug, { force: true }))
    const outcomes = Promise.allSettled(promises)
    await flush()
    gates[0].reject(new Error("AbortError"))
    gates[1].resolve()
    await flush()
    expect(started).toHaveLength(4)
    gates[2].resolve(); gates[3].resolve()
    expect((await outcomes).map((r) => r.status)).toEqual(["rejected", "rejected", "fulfilled", "fulfilled"])
    expect(finished).toEqual(["succeeds", "also-succeeds"])
    expect(patchRecipe).toHaveBeenCalledTimes(3)
    expect(peak).toBe(2)
  })

  it("holds a slot until writeback finishes", async () => {
    const writing = deferred()
    vi.mocked(patchRecipe).mockImplementationOnce(async () => writing.promise)
    const all = Promise.all(["one", "two", "three"].map((slug) => runEstimationPipeline(slug)))
    await flush()
    gates[0].resolve()
    await flush()
    expect(patchRecipe).toHaveBeenCalledTimes(1)
    expect(started).toEqual(["one", "two"])
    writing.resolve()
    await flush()
    expect(started).toEqual(["one", "two", "three"])
    gates[1].resolve(); gates[2].resolve()
    await all
  })

  it("serializes the same slug without blocking unrelated recipes or reading stale state early", async () => {
    const all = Promise.all(["same", "same", "other"].map((slug) => runEstimationPipeline(slug, { force: true })))
    await flush()
    expect(started).toEqual(["same", "other"])
    expect(getRecipe).toHaveBeenCalledTimes(2)
    gates[0].resolve()
    await flush()
    expect(started).toEqual(["same", "other", "same"])
    expect(getRecipe).toHaveBeenCalledTimes(3)
    gates[1].resolve(); gates[2].resolve()
    await all
    expect(patchRecipe).toHaveBeenCalledTimes(3)
  })

  it("shares slots across estimate requests, webhooks and direct/backfill callers", async () => {
    const app = Fastify()
    await app.register(estimateRoutes)
    await app.register(webhookRoutes)
    try {
      await app.inject({ method: "POST", url: "/estimate/estimate?force=true" })
      await app.inject({ method: "POST", url: "/webhook", payload: {
        document_data: { document_type: "recipe", recipe_slug: "webhook", operation: "update" },
      } })
      await flush()
      const backfill = runEstimationPipeline("backfill")
      expect(started).toEqual(["estimate", "webhook"])
      gates[0].resolve()
      await flush()
      expect(started).toEqual(["estimate", "webhook", "backfill"])
      gates[1].resolve(); gates[2].resolve()
      await backfill
      expect(peak).toBe(2)
    } finally { await app.close() }
  })
})

describe("queue configuration", () => {
  it.each([1, 3])("executes at most %i concurrent tasks", async (limit) => {
    const queue = new EstimationQueue(limit)
    const blockers = Array.from({ length: 6 }, deferred)
    let running = 0
    let maximum = 0
    const all = Promise.all(blockers.map((gate, i) => queue.run(String(i), async () => {
      running++; maximum = Math.max(maximum, running)
      await gate.promise
      running--
    })))
    expect(running).toBe(limit)
    for (const gate of blockers) gate.resolve()
    await all
    expect(maximum).toBe(limit)
  })

  it("releases a recipe lock after a synchronous throw", async () => {
    const queue = new EstimationQueue(1)
    const failed = queue.run("same", () => { throw new Error("failure") })
    const next = queue.run("same", async () => "done")
    await expect(failed).rejects.toThrow("failure")
    await expect(next).resolves.toBe("done")
  })
})
