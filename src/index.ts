import Fastify from "fastify"
import cors from "@fastify/cors"
import { config } from "./config.js"
import { logger } from "./utils/logger.js"
import { initCache, flushCache } from "./utils/cache.js"
import { initOverrides, flushOverrides, countOverrides } from "./services/food-overrides.js"
import { webhookRoutes } from "./routes/webhook.js"
import { estimateRoutes } from "./routes/estimate.js"
import { backfillRoutes } from "./routes/backfill.js"
import { overrideRoutes } from "./routes/overrides.js"
import { getUsdaLocalData } from "./services/providers/usda-local-provider.js"

async function main() {
  await initCache()
  await initOverrides()
  const app = Fastify({
    logger: false,
  })

  await app.register(cors)

  await app.register(webhookRoutes)
  await app.register(estimateRoutes)
  await app.register(backfillRoutes)
  await app.register(overrideRoutes)

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
    flushOverrides()
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
    // Booleans and a version only — never a key — so operators can confirm from logs alone what
    // is wired up, without anyone (including an operator debugging remotely) needing to read a
    // secret out of the environment. `usdaConfigured` used to mean "an API key is set"; USDA is
    // now a bundled offline database, so the honest signal is whether that database loaded.
    const usdaLocal = await getUsdaLocalData()
    logger.info(
      {
        port: config.port,
        usdaLocalEnabled: usdaLocal !== null,
        usdaLocalDatasets: usdaLocal?.datasets ?? null,
        llmEnabled: config.llm.enabled && Boolean(config.llm.apiKey),
        // Reported because it is an OPT-IN: with the code default now false, a deployment that
        // means to run the semantic judge must say so in its environment, and the only way to
        // confirm it did is to see it here. Silently starting without it would quietly return the
        // service to the purely deterministic chain.
        judgeEnabled: config.llm.judgeEnabled,
        judgeModel: config.llm.judgeEnabled ? config.llm.judgeModel : null,
        foodOverrides: countOverrides(),
        overrideApiEnabled: Boolean(config.overrides.adminToken),
      },
      "Calorie estimator server started",
    )
  } catch (err) {
    logger.error({ err }, "Failed to start server")
    process.exit(1)
  }
}

main()
