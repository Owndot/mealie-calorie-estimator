import type { FastifyInstance } from "fastify"
import { runEstimationPipeline, type PipelineOptions } from "../services/pipeline.js"
import { logger } from "../utils/logger.js"

async function processEstimate(slug: string, opts: PipelineOptions): Promise<void> {
  try {
    logger.info({ slug, opts }, "On-demand estimation processing")
    const outcome = await runEstimationPipeline(slug, opts)
    logger.info({ slug, outcome }, "On-demand estimation complete")
  } catch (err) {
    logger.error({ slug, err }, "Estimate background processing failed")
  }
}

function parseBool(v: unknown): boolean {
  return v === true || v === "true" || v === "1"
}

export async function estimateRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Force-recalculate one recipe: POST /estimate/:slug?force=true
   * force bypasses the ingredient-hash-unchanged skip only. It never overwrites genuinely
   * manual nutrition by itself — that requires the separate, explicit overrideManual=true.
   */
  app.post<{ Params: { slug: string }; Querystring: { force?: string; overrideManual?: string } }>(
    "/estimate/:slug",
    async (req, reply) => {
      const { slug } = req.params
      const opts: PipelineOptions = {
        force: parseBool(req.query.force),
        overrideManual: parseBool(req.query.overrideManual),
      }

      logger.info({ slug, opts }, "On-demand estimation requested")

      reply.status(202).send({ status: "accepted" })

      setImmediate(() => processEstimate(slug, opts))
    },
  )
}
