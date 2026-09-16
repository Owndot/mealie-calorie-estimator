# Cache versioning and migration

The estimator persists four tables in a SQLite file (`CACHE_DB_PATH`, default `data/cache.db`):

| table | holds | TTL |
|---|---|---|
| `provider_match_cache` | a provider's accepted candidate for a query | 7 days |
| `provider_miss_cache` | "this provider had nothing acceptable" | 1 day |
| `llm_estimate_cache` | unit→gram estimates (and volume densities) | 12 hours |
| `llm_nutrient_cache` | per-food LLM nutrient fallbacks | 12 hours |

## How invalidation works

There is **no destructive migration and no manual step**. Every cache key carries a version
prefix, so when matching semantics change the old rows simply stop being addressable and expire
through the normal TTL sweep:

- `BLS_MATCH_ALGORITHM_VERSION`, `OFF_MATCH_ALGORITHM_VERSION`, `USDA_MATCH_ALGORITHM_VERSION`
  prefix each provider's positive and negative keys.
- `LLM_ESTIMATE_CACHE_KEY_VERSION` / `LLM_NUTRIENT_CACHE_KEY_VERSION` do the same for the LLM
  caches.

A deployment that upgrades therefore keeps its existing file, re-resolves ingredients once as the
new keys miss, and drops the stale rows automatically within the TTL window. Users never need to
delete `cache.db`.

## What changed with structured food state

Semantic attributes (`form`, `preservation`, `fatPercent`) now participate in matching, so they
must participate in cache identity too. Two lookups with the same text but different attributes are
different questions, and a stored candidate name cannot distinguish them — revalidation alone is
not sufficient. The attribute triple is therefore part of the **positive** key for all three
providers, alongside the existing version prefix:

```
<VERSION>:<query text>|<state>|<form>/<preservation>/<fat%>
```

This is what makes the following impossible after upgrade, rather than merely unlikely:

| a cached match for | can never be served to |
|---|---|
| ground/dried ginger | a `preservation: fresh` ginger query |
| half-fat butter | a plain butter query (also rejected by the modifier rule) |
| 15% cream | a `fatPercent: 7` query |
| coriander seed | a `form: leaf` query |
| dry beans | a `preservation: canned` query |

Versions bumped in this change: **BLS v20 → v21**, **OFF v15 → v16**, **USDA v15 → v16**.

## What changed with asymmetric-specificity matching

Matching now rejects a candidate that introduces a subtype, plant part or derived-product identity
the query never named, and prefers a record that *states* an attribute the query asked for over one
that is merely silent about it. That changes which record wins for a given query text, so stored
matches from the previous algorithm must stop being addressable:

| a cached match for | can never be served again |
|---|---|
| plain pasta | rice noodles / egg pasta |
| plain mustard | sweet mustard |
| a garlic seasoning | raw garlic |
| pickle brine | raw cucumber |
| canned beans | a dry or raw record, when a canned one exists |
| an ambiguous herb name | one plant part, when the database offers several |
| a generic ingredient | a sub-variety with a different base (lupin flour for flour, root parsley for parsley) |

The `cachedMatchConflict()` revalidation covers the query-side half of this for free, since it can
re-run against the stored candidate's own name. The plant-part half cannot be revalidated that way
— it is evidence about the whole candidate *set*, which a single cache row does not preserve — so
it relies on the attribute triple already being part of every positive key.

Versions bumped in this change: **BLS v21 → v22**, **OFF v16 → v17**, **USDA v16 → v17**.

## Operational effect

The first run after upgrading is a cold re-resolve for provider matches: slower, and it issues
fresh OFF/USDA requests for ingredients whose old entries are no longer addressable. Subsequent
runs are warm again. LLM gram/nutrient caches are unaffected by this change and keep their
existing rows.

No schema change is required — the added semantics live inside the key string, not in new columns.

## What changed with production hardening

Matching semantics changed again, so stored matches from the previous algorithm must stop being
addressable:

| a cached match for | can never be served again |
|---|---|
| a pluralised German ingredient | a miss (the core gate now joins "Kidneybohnen" to "Kidneybohne") |
| pickle brine | cucumber juice — derived products are classed, not lumped together |
| a stated light/lean claim | a record that does not answer it, when one that does exists |

The `provider_match_cache` also gained a `provenance` column, added by `ALTER TABLE` when absent
because `CREATE TABLE IF NOT EXISTS` does nothing to an existing database. Without it a cache HIT
silently dropped `llmReranked`/`rerankReason`/`unmetAttributes` — visible in production as a match
reported at a rerank-only confidence of 0.8 while claiming it had never been reranked.

Versions bumped in this change: **BLS v22 → v23**, **OFF v17 → v18**, **USDA v17 → v18**.

## Recipe-source dependencies

The `mealie-recipe` provider does not use the provider cache at all — it reads the source recipe
live, so there is no stored nutrient value to go stale. What *is* persisted is the dependency: a
consumer records `calorie_estimator_recipe_sources` (slug → fingerprint of the source's
nutrition/servings/yield). At the consumer's next run, a changed fingerprint forces re-estimation
even though its own ingredient hash is unchanged. This is checked at the dependent rather than
cascaded from the source, so nothing can storm.

## Provenance round-trip

`provider_match_cache` carries a `provenance` JSON column holding `llmReranked`, `rerankReason` and
`unmetAttributes`. It must stay in the SELECT list: it was added to the table, the write, the row
type and the read-back call but omitted from the SELECT, so `row.provenance` was always undefined
and every cache HIT came back claiming it had never been reranked — visible in production as
`matchReason: "llm-reranked"` next to `llmReranked: false`. A regression test now round-trips all
four fields.
