import Fastify from "fastify"
import cors from "@fastify/cors"
import { config } from "./config.js"
import { logger } from "./utils/logger.js"
import { initCache, flushCache } from "./utils/cache.js"
import { webhookRoutes } from "./routes/webhook.js"
import { estimateRoutes } from "./routes/estimate.js"
import { backfillRoutes } from "./routes/backfill.js"

async function main() {
  await initCache()
  const app = Fastify({
    logger: false,
  })

  await app.register(cors)

  await app.register(webhookRoutes)
  await app.register(estimateRoutes)
  await app.register(backfillRoutes)

  app.get("/health", async () => {
    return { status: "ok", timestamp: new Date().toISOString() }
  })

  // The SQLite cache debounces writes by 5s (see scheduleSave in utils/cache.ts) — without an
  // explicit flush on shutdown, up to 5s of provider matches/misses/LLM estimates written just
  // before a container stop or rolling restart are lost, forcing avoidable re-lookups after
  // every restart under continuous traffic.
  let shuttingDown = false
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    logger.info({ signal }, "Shutting down, flushing cache")
    flushCache()
    try {
      await app.close()
    } finally {
      process.exit(0)
    }
  }
  process.on("SIGTERM", () => void shutdown("SIGTERM"))
  process.on("SIGINT", () => void shutdown("SIGINT"))

  try {
    await app.listen({ port: config.port, host: "0.0.0.0" })
    // Boolean-only — never the key itself — so operators can confirm USDA is wired up from logs
    // alone, without anyone (including an operator debugging remotely) ever needing to read the
    // actual secret value out of the environment/config.
    logger.info(
      { port: config.port, usdaConfigured: Boolean(config.usda.apiKey), llmEnabled: config.llm.enabled && Boolean(config.llm.apiKey) },
      "Calorie estimator server started",
    )
  } catch (err) {
    logger.error({ err }, "Failed to start server")
    process.exit(1)
  }
}

main()
