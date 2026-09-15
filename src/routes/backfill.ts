import type { FastifyInstance } from "fastify"
import { getAllRecipes } from "../services/mealie-client.js"
import { runEstimationPipeline } from "../services/pipeline.js"
import { logger } from "../utils/logger.js"

async function processBackfill(): Promise<void> {
  try {
    const allSlugs = await getAllRecipes()
    const counts = {
      processed: 0,
      estimated: 0,
      noOp: 0,
      manualPreserved: 0,
      tagsUpdated: 0,
      skippedNotTagged: 0,
      errors: 0,
    }

    for (const slug of allSlugs) {
      counts.processed++

      try {
        const outcome = await runEstimationPipeline(slug)
        switch (outcome.status) {
          case "estimated":
            counts.estimated++
            break
          case "no-op":
            counts.noOp++
            break
          case "manual-preserved":
            counts.manualPreserved++
            break
          case "tags-updated":
            counts.tagsUpdated++
            break
          case "skipped-not-tagged":
            counts.skippedNotTagged++
            break
        }
      } catch (err) {
        counts.errors++
        logger.error({ slug, err }, "Backfill error for recipe")
      }

      if (counts.processed % 10 === 0) {
        logger.info({ ...counts, total: allSlugs.length }, "Backfill progress")
      }
    }

    logger.info({ ...counts, total: allSlugs.length }, "Backfill complete")
  } catch (err) {
    logger.error({ err }, "Backfill background processing failed")
  }
}

export async function backfillRoutes(app: FastifyInstance): Promise<void> {
  app.post("/backfill", async (req, reply) => {
    logger.info("Backfill requested")

    reply.status(202).send({ status: "accepted" })

    setImmediate(() => processBackfill())
  })
}
