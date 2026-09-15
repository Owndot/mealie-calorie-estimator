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

## Operational effect

The first run after upgrading is a cold re-resolve for provider matches: slower, and it issues
fresh OFF/USDA requests for ingredients whose old entries are no longer addressable. Subsequent
runs are warm again. LLM gram/nutrient caches are unaffected by this change and keep their
existing rows.

No schema change is required — the added semantics live inside the key string, not in new columns.
