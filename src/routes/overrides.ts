import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify"
import { config } from "../config.js"
import { logger } from "../utils/logger.js"
import { normalizeIngredients } from "../services/llm-normalizer.js"
import { resolveNutrients } from "../services/nutrient-resolver.js"
import { loadOverrideTarget } from "../services/providers/override-provider.js"
import { getRecipe } from "../services/mealie-client.js"
import {
  buildOverrideKey, overrideId, listOverrides, getOverrideById, setOverride, deleteOverride,
  OVERRIDE_KEY_VERSION, type FoodOverride, type OverrideProvider, type OverrideIdentity,
} from "../services/food-overrides.js"
import { UNKNOWN_ATTRIBUTES, type FoodAttributes } from "../types.js"

/**
 * Management for user-confirmed food overrides.
 *
 * Addressed by a short opaque `id`, never by the semantic key: the key contains spaces and
 * separators, and its shape is free to change, so making callers URL-encode it correctly would
 * turn a formatting slip into a wrong or failed operation. Both are returned everywhere, so the
 * key stays visible for audit.
 *
 * The whole surface is gated by OVERRIDE_ADMIN_TOKEN. Unset means the routes are not registered
 * at all — a deployment that has not configured a token has no write API, and does not advertise
 * that one exists.
 */

const VALID_PROVIDERS: OverrideProvider[] = ["bls", "usda-local", "off", "mealie-recipe"]

function unauthorized(reply: FastifyReply): void {
  // 401 without a WWW-Authenticate challenge listing anything useful: this is a fixed-token API,
  // not an interactive login.
  reply.status(401).send({ error: "Unauthorized" })
}

function authorized(req: FastifyRequest): boolean {
  const header = req.headers.authorization
  if (typeof header !== "string") return false
  const [scheme, token] = header.split(" ")
  return scheme?.toLowerCase() === "bearer" && token === config.overrides.adminToken
}

/** The public shape of one override, with its target's live status. */
async function describe(o: FoodOverride): Promise<Record<string, unknown>> {
  const target = await loadOverrideTarget(o)
  const stale = o.keyVersion !== OVERRIDE_KEY_VERSION
  return {
    id: o.id,
    overrideKey: o.overrideKey,
    keyVersion: o.keyVersion,
    // A row written under an older key shape describes an identity this build no longer computes,
    // so it is reported rather than silently re-targeted.
    stale,
    exampleName: o.exampleName,
    identity: {
      canonicalEnglish: o.canonicalEnglish,
      state: o.state,
      form: o.form,
      preservation: o.preservation,
      fatPercent: o.fatPercent,
      brand: o.brand,
    },
    target: {
      provider: o.provider,
      providerId: o.providerId,
      recordNameWhenBound: o.recordName,
      // Reloaded live. `null` means the binding is broken and this ingredient currently falls back
      // to ordinary resolution.
      current: target && {
        name: target.name,
        kcalPer100g: target.nutrients.kcalPer100g,
        fatPer100g: target.nutrients.fatPer100g,
      },
      status: target ? "ok" : "broken",
    },
    source: o.source,
    note: o.note,
    createdAt: new Date(o.createdAt).toISOString(),
    updatedAt: new Date(o.updatedAt).toISOString(),
  }
}

/**
 * Classifies one ingredient exactly as the estimator would, so the key a binding will use is
 * derived from the same pipeline rather than hand-assembled by the caller.
 */
async function classifyOne(foodName: string, unitName: string | null): Promise<{
  identity: OverrideIdentity
  attributes: FoodAttributes
  canonicalGerman: string
  coreFoodEnglish: string | null
  category: string | null
  foodType: string
}> {
  const [c] = await normalizeIngredients([{ index: 0, foodName, unitName }])
  return {
    identity: {
      canonicalEnglish: c.canonicalEnglish,
      state: c.state,
      attributes: c.attributes ?? UNKNOWN_ATTRIBUTES,
      brand: c.brand,
    },
    attributes: c.attributes ?? UNKNOWN_ATTRIBUTES,
    canonicalGerman: c.canonicalGerman,
    coreFoodEnglish: c.coreFoodEnglish,
    category: c.category,
    foodType: c.foodType,
  }
}

export async function overrideRoutes(app: FastifyInstance): Promise<void> {
  if (!config.overrides.adminToken) {
    logger.info("OVERRIDE_ADMIN_TOKEN is not set — the food-override management API is disabled")
    return
  }

  /**
   * A DELETE carrying `Content-Type: application/json` and no body is rejected by Fastify's
   * default parser as an empty JSON document. That is a real client shape, not a malformed one:
   * a wrapper or client that sets the header once for every request has nothing to put in a
   * DELETE body. Found immediately, by the scoped admin wrapper on the first live delete.
   */
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    const text = typeof body === "string" ? body.trim() : ""
    if (text.length === 0) return done(null, {})
    try {
      done(null, JSON.parse(text))
    } catch {
      // Unparseable input is the CALLER's mistake. Without an explicit status Fastify reports it
      // as a 500, which would send someone hunting a server fault over a stray comma.
      const err = Object.assign(new Error("Body is not valid JSON"), { statusCode: 400 })
      done(err, undefined)
    }
  })

  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/overrides")) return
    if (!authorized(req)) {
      unauthorized(reply)
      return reply
    }
  })

  app.get("/overrides", async () => ({
    keyVersion: OVERRIDE_KEY_VERSION,
    overrides: await Promise.all(listOverrides().map(describe)),
  }))

  app.get<{ Params: { id: string } }>("/overrides/:id", async (req, reply) => {
    const o = getOverrideById(req.params.id)
    if (!o) return reply.status(404).send({ error: "No such override" })
    return describe(o)
  })

  /**
   * What WOULD happen for an ingredient: the key it produces, and what it resolves to today.
   * Run this before binding, so a choice is made against the current behaviour rather than a
   * remembered one.
   */
  app.post<{ Body: { foodName?: string; unitName?: string | null } }>("/overrides/preview", async (req, reply) => {
    const foodName = req.body?.foodName?.trim()
    if (!foodName) return reply.status(400).send({ error: "foodName is required" })

    const c = await classifyOne(foodName, req.body?.unitName ?? null)
    const key = buildOverrideKey(c.identity)
    const id = overrideId(key)

    const resolved = await resolveNutrients({
      foodName: c.identity.canonicalEnglish, structuredName: foodName, canonicalGerman: c.canonicalGerman,
      brand: c.identity.brand, category: c.category, state: c.identity.state, foodType: c.foodType,
      coreFoodGerman: null, coreFoodEnglish: c.coreFoodEnglish, route: c.identity.brand ? "branded" : "generic",
      attributes: c.attributes, evidence: { german: true, english: true, core: true, brand: Boolean(c.identity.brand) },
    } as never, c.identity.brand ? "branded" : "generic")

    const existing = getOverrideById(id)
    return {
      foodName,
      overrideKey: key,
      id,
      identity: c.identity,
      existingOverride: existing ? await describe(existing) : null,
      resolvesToday: resolved && {
        provider: resolved.fallbackStatus,
        providerId: resolved.match.providerId,
        productName: resolved.match.productName,
        kcalPer100g: resolved.match.nutrients.kcalPer100g,
        fatPer100g: resolved.match.nutrients.fatPer100g,
        confidence: resolved.match.confidence,
        matchReason: resolved.match.matchReason ?? null,
        unmetAttributes: resolved.match.unmetAttributes ?? [],
      },
    }
  })

  /** Creates or replaces the binding for the ingredient's key. */
  app.put<{ Body: { foodName?: string; unitName?: string | null; provider?: string; providerId?: string; note?: string } }>(
    "/overrides",
    async (req, reply) => {
      const foodName = req.body?.foodName?.trim()
      const provider = req.body?.provider as OverrideProvider | undefined
      const providerId = req.body?.providerId?.trim()
      if (!foodName || !provider || !providerId) {
        return reply.status(400).send({ error: "foodName, provider and providerId are required" })
      }
      if (!VALID_PROVIDERS.includes(provider)) {
        return reply.status(400).send({ error: `provider must be one of: ${VALID_PROVIDERS.join(", ")}` })
      }

      const c = await classifyOne(foodName, req.body?.unitName ?? null)

      // The target must be loadable NOW. Binding to something that cannot be read would store a
      // decision that is broken from birth, and the person would not find out until a recipe
      // quietly failed to change.
      const probe = await loadOverrideTarget({
        id: "", overrideKey: "", keyVersion: OVERRIDE_KEY_VERSION, exampleName: foodName,
        canonicalEnglish: c.identity.canonicalEnglish, state: c.identity.state,
        form: c.attributes.form, preservation: c.attributes.preservation,
        fatPercent: c.attributes.fatPercent, brand: c.identity.brand,
        provider, providerId, recordName: "", source: "user-confirmed", note: null,
        createdAt: 0, updatedAt: 0,
      })
      if (!probe) {
        return reply.status(422).send({ error: `The ${provider} record "${providerId}" could not be loaded` })
      }

      const saved = setOverride({
        identity: c.identity, exampleName: foodName, provider, providerId,
        recordName: probe.name, note: req.body?.note ?? null,
      })
      logger.info({ overrideId: saved.id, foodName, provider, providerId, record: probe.name }, "Food override bound")
      return reply.status(200).send(await describe(saved))
    },
  )

  app.delete<{ Params: { id: string } }>("/overrides/:id", async (req, reply) => {
    const o = getOverrideById(req.params.id)
    if (!o) return reply.status(404).send({ error: "No such override" })
    deleteOverride(req.params.id)
    logger.info({ overrideId: o.id, provider: o.provider, providerId: o.providerId }, "Food override deleted")
    return reply.status(200).send({ deleted: o.id, overrideKey: o.overrideKey })
  })

  /**
   * Ingredients in the named recipes that automatic resolution could not settle — an unmet
   * attribute, or no database record at all. Bounded by explicit slugs rather than scanning every
   * recipe, so this stays a lookup and not a crawl.
   */
  app.get<{ Querystring: { slug?: string | string[] } }>("/overrides/suggestions", async (req, reply) => {
    const raw = req.query?.slug
    const slugs = (Array.isArray(raw) ? raw : raw ? [raw] : []).filter(Boolean)
    if (slugs.length === 0) return reply.status(400).send({ error: "at least one ?slug= is required" })

    const suggestions: Record<string, unknown>[] = []
    for (const slug of slugs) {
      const recipe = await getRecipe(slug)
      if (!recipe) continue
      const provenanceRaw = recipe.extras?.calorie_estimator_provenance
      if (typeof provenanceRaw !== "string") continue
      let rows: Record<string, unknown>[]
      try {
        rows = JSON.parse(provenanceRaw) as Record<string, unknown>[]
      } catch {
        continue
      }
      for (const row of rows) {
        const unmet = Array.isArray(row.unmetAttributes) ? row.unmetAttributes : []
        const fabricated = row.provider === "llm-nutrient" || row.provider === null
        if (unmet.length === 0 && !fabricated) continue
        const name = String(row.name)
        const c = await classifyOne(name, null)
        const key = buildOverrideKey(c.identity)
        suggestions.push({
          slug,
          foodName: name,
          reason: unmet.length > 0 ? `unmet: ${unmet.join(", ")}` : "no database record",
          currentProvider: row.provider ?? null,
          currentRecord: row.productName ?? null,
          overrideKey: key,
          id: overrideId(key),
          alreadyOverridden: Boolean(getOverrideById(overrideId(key))),
        })
      }
    }
    return { suggestions }
  })
}
