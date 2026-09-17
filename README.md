# Mealie Nutrition Engine

[![CI](https://github.com/Owndot/mealie-nutrition-engine/actions/workflows/ci.yml/badge.svg)](https://github.com/Owndot/mealie-nutrition-engine/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/Owndot/mealie-nutrition-engine?label=release)](https://github.com/Owndot/mealie-nutrition-engine/releases)
[![License](https://img.shields.io/badge/license-GPL--3.0--only-blue)](LICENSE)

Automatic, provenance-aware nutrition for recipes in [Mealie](https://mealie.io/). It listens for
recipe webhooks, resolves every ingredient against real food-composition records, calculates the
recipe deterministically, and writes the result back — recording, for each ingredient, exactly
which record the numbers came from and what it could not answer.

---

## Why this exists

Working out a recipe's nutrition sounds like a database lookup. It is not.

Real recipes are full of ingredients that a search cannot honestly resolve on its own: *lean* mince,
*light* mayonnaise, raw versus cooked, "5 % fat" versus "10 % fat", a generic ingredient versus a
particular retail product, and German food names that have no clean equivalent in international
databases.

A naive database search will happily return something. Ask it for lean mince and it returns mince —
quietly dropping the word that mattered, and with it about 60 kcal per 100 g. An LLM-only estimator
has the opposite failure: it always answers, the answer is not reproducible, and the numbers are
invented rather than measured.

This project takes a third position:

- **prefer real, deterministic nutrition records** — bundled reference databases, not generated values;
- **preserve provenance** — every ingredient records its source, record id and confidence;
- **represent unresolved attributes instead of hiding them** — if a record does not satisfy "lean",
  it is used *and flagged*, never silently treated as equivalent;
- **use semantic/LLM assistance only where deterministic evidence is insufficient** — and never to
  produce a nutrient value when a real record exists.

Some ambiguity cannot be resolved honestly at all. Asked which of four genuine light mayonnaises a
recipe means, the right machine answer is "I don't know". **User-confirmed overrides** exist for
exactly that: you choose the real record once, and the engine remembers it.

## Features

- Recipe-created / recipe-updated webhooks, with loop prevention
- Deterministic gram resolution from Mealie's structured quantities and units (German units included)
- Multi-source resolution with hard semantic gates, so a wrong-but-similar food is rejected rather than used
- Per-ingredient provenance: provider, record id, confidence, unmet attributes, classification
- Persistent SQLite caching, surviving restarts
- User-confirmed overrides with a small admin API
- Manual-nutrition protection and a force-recalculate endpoint
- Optional auto-tagging by calorie band and digestibility

## Nutrition sources

Consulted in this order. Each is silent unless it has something for the ingredient.

| # | Source | What it is | When it answers |
|---|---|---|---|
| 1 | **Your Mealie recipes** | your own computed recipes | an ingredient named exactly like one of your recipes — a homemade paste or spice mix no public database can know |
| 2 | **User-confirmed overrides** | a record you chose | you have deliberately bound this exact ingredient |
| 3 | **BLS 4.0** | German Bundeslebensmittelschlüssel, 7,140 records, bundled | German ingredient identities; the primary source for German recipes |
| 4 | **USDA FoodData Central** | Foundation + SR Legacy, 8,262 generic records, bundled | generic foods, especially where BLS has no entry |
| 5 | **Open Food Facts** | branded retail products, queried live | branded ingredients, and as a *verified proxy* for a property no generic database carries |
| 6 | **LLM estimate** | a generated value | last resort, clearly marked as such |

Both reference databases are **bundled in the image**: no API key, no network call, no rate limit,
and the same data every time. Open Food Facts is used selectively rather than as a general
database — see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

### Where the LLM is used, and where it is not

| Used for | Not used for |
|---|---|
| Normalizing and translating ingredient identities (one batched request per recipe, cached) | Calculating anything |
| Estimating grams for units that cannot be converted deterministically | Overriding your structured quantities |
| Choosing **between real records** that retrieval already found | Inventing a nutrient value when a real record exists |

The semantic judge is **off by default** (`LLM_JUDGE_ENABLED`). When enabled, it is consulted only
where the alternative is a generated number, it can only ever return an id from the records it was
shown, and "ambiguous" or "none" are valid answers that leave the existing result untouched.

## Language support

**German** — the primary language. Extensively production-tested, with BLS as a first-class local
source and the main regression focus. German works particularly well because BLS is bundled, German
food terminology has been the production and test focus throughout, and semantic normalization maps
German ingredients onto the English canonical identities the other providers use.

**English** — supported on a best-effort basis and partially regression-tested. Many common
ingredients resolve correctly (`black beans`, `pasta`, `tomato paste`, `olive oil`, `onion`,
`parmesan`, `lean ground beef`, `ground beef 5% fat`). It is **not yet at German parity**: some
under-qualified terms can lose part of their identity during classification, and qualified
retail-style terms such as `light mayonnaise` may stay flagged rather than receiving an exact
record. See the open issues.

**Other languages** — may work through semantic normalization and international sources such as
Open Food Facts, but have **not** been systematically validated.

## Requirements

- A running Mealie instance (v2+) and an API token
- Docker and Docker Compose
- Optional: an OpenAI-compatible LLM endpoint and key

## Installation

```bash
git clone https://github.com/Owndot/mealie-nutrition-engine.git
cd mealie-nutrition-engine
cp .env.example .env
$EDITOR .env          # at minimum: MEALIE_URL and MEALIE_API_TOKEN
docker compose up -d nutrition-engine
```

The published image can be used directly instead of building:

```yaml
services:
  nutrition-engine:
    image: ghcr.io/owndot/mealie-nutrition-engine:latest
    environment:
      MEALIE_URL: http://mealie:9000
      MEALIE_API_TOKEN: ${MEALIE_API_TOKEN}
    ports:
      - "127.0.0.1:8000:8000"
    volumes:
      - nutrition-engine-data:/app/data
    restart: unless-stopped

volumes:
  nutrition-engine-data:
```

The engine must be able to reach Mealie, and Mealie must be able to reach the engine — put both on
the same Docker network.

### Connect Mealie

In Mealie: **Settings → Notifiers → Create**, with an Apprise URL pointing at the engine:

```
json://nutrition-engine:8000/webhook
```

Enable **Recipe Created** and **Recipe Updated**; leave the rest off.

### Verify the installation

```bash
curl -s http://127.0.0.1:8000/health
# {"status":"ok","timestamp":"..."}

docker compose logs nutrition-engine | grep "server started"
# ...,"usdaLocalEnabled":true,"usdaLocalDatasets":"Foundation ...; SR Legacy ...",
#     "llmEnabled":false,"judgeEnabled":false,"foodOverrides":0,...
```

`usdaLocalEnabled: true` confirms the bundled databases loaded. Then force one recipe through:

```bash
curl -X POST "http://127.0.0.1:8000/estimate/<recipe-slug>?force=true"
```

and check the recipe in Mealie for nutrition values and a `calorie_estimator_provenance` extra.

## Configuration

Every supported variable is documented in [`.env.example`](.env.example). Only two are required:

| Variable | Required | Notes |
|---|---|---|
| `MEALIE_URL` | **yes** | e.g. `http://mealie:9000` |
| `MEALIE_API_TOKEN` | **yes** | a dedicated service-account token |
| `LLM_ENABLED`, `LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL` | no | any OpenAI-compatible endpoint |
| `LLM_JUDGE_ENABLED` | no | semantic judge, **off** by default |
| `OVERRIDE_ADMIN_TOKEN` | no | enables the override API; unset means those routes do not exist |
| `CACHE_DB_PATH`, `OVERRIDES_DB_PATH` | no | default to `data/` |

### Persistence and backups

Both databases live in `/app/data`:

| File | Rebuildable? | Notes |
|---|---|---|
| `cache.db` | **yes** | provider matches, LLM classifications, judge decisions. Safe to delete; it refills. |
| `overrides.db` | **no** | the records you deliberately chose. **Back this up.** |

Keep `/app/data` on a named volume or bind mount. Both survive container recreation.

## User-confirmed overrides

When automatic resolution is ambiguous or knowingly incomplete, bind the ingredient to a real
record once and the engine remembers it. An override is a **pointer**, never a copy of the numbers:
the nutrients are reloaded from the provider every time, and a target that cannot be loaded falls
back to normal resolution rather than serving something stale.

Set `OVERRIDE_ADMIN_TOKEN` to enable the API; every request needs `Authorization: Bearer <token>`.

```bash
TOKEN=...   # OVERRIDE_ADMIN_TOKEN

# What does this ingredient resolve to, and what key would an override use?
curl -sX POST http://127.0.0.1:8000/overrides/preview \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"foodName":"Rinderhackfleisch mager","unitName":"g"}'

# Bind it to a real record (bls | usda-local | off | mealie-recipe)
curl -sX PUT http://127.0.0.1:8000/overrides \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"foodName":"Rinderhackfleisch mager","unitName":"g",
       "provider":"off","providerId":"4313249214975"}'

curl -s  http://127.0.0.1:8000/overrides                    -H "Authorization: Bearer $TOKEN"
curl -sX DELETE http://127.0.0.1:8000/overrides/<id>        -H "Authorization: Bearer $TOKEN"
curl -s "http://127.0.0.1:8000/overrides/suggestions?slug=<recipe-slug>" -H "Authorization: Bearer $TOKEN"
```

`preview` shows both what the ingredient resolves to **now** and what it would resolve to
**without** the override, so a binding is always made against the current behaviour. Full details in
[`docs/OVERRIDES.md`](docs/OVERRIDES.md).

> **Security.** `OVERRIDE_ADMIN_TOKEN` grants write access to how your nutrition is resolved. Use a
> long random value, keep it out of version control, and do not expose port 8000 beyond your own
> network — the examples bind to `127.0.0.1` deliberately.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | liveness |
| `POST` | `/webhook` | Mealie notifier target |
| `POST` | `/estimate/:slug?force=true` | recalculate one recipe |
| `POST` | `/backfill` | recalculate in bulk |
| `*` | `/overrides…` | override management (token required) |

## Updating

```bash
docker compose pull nutrition-engine && docker compose up -d nutrition-engine
```

Your data volume is untouched. If a release changes matching behaviour, the notes say so.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `getaddrinfo EAI_AGAIN mealie` | the containers are not on the same Docker network |
| Recipes never update | the Mealie notifier is not enabled, or not pointed at `/webhook` |
| `usdaLocalEnabled:false` at startup | the image was built without `resources/` — rebuild |
| Nutrition looks wrong for one ingredient | read its `calorie_estimator_provenance` row; if `unmetAttributes` is non-empty the engine is telling you it could not satisfy a stated property — a good override candidate |
| Judge never runs | `LLM_JUDGE_ENABLED` is off by default, and requires `LLM_ENABLED` + a key |
| Override API returns 401/404 | `OVERRIDE_ADMIN_TOKEN` unset (404) or wrong (401) |

Set `LOG_LEVEL=debug` for per-ingredient resolution detail.

## Development

```bash
npm install
npm run dev          # watch mode
npm test             # 870 tests
npm run typecheck
npm run build
```

Tests run against the **real** bundled BLS and USDA databases — a matching change that breaks a real
food fails the suite. See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for provider order and
gating, [`docs/CACHING.md`](docs/CACHING.md) for cache layers and TTLs.

## Limitations

- German is the validated language; English is best-effort (see above)
- Open Food Facts is live data: products appear and disappear, and search results drift
- LLM-estimated ingredients are marked `llm-nutrient` and are estimates, not measurements
- Unknown is not zero — unresolved ingredients are withheld or flagged, never silently counted as 0
- Nutrition is computed for whole recipes and divided by servings exactly once; per-portion accuracy
  depends on Mealie's `recipeServings` being correct

## Contributing

Issues and pull requests are welcome. Conventional commit titles, and please keep the test suite
green — including the regression tests that pin real foods to real records.

## License and attribution

Licensed under the **GNU General Public License v3.0 only** (`GPL-3.0-only`) — see [LICENSE](LICENSE).

This project began as a fork of
[timo-reymann/mealie-calorie-estimator](https://github.com/timo-reymann/mealie-calorie-estimator)
and retains its licence and copyright. The nutrition engine has since been substantially rewritten
and extended: multi-source resolution with semantic gating, bundled BLS and USDA databases, the
provenance model, persistent caching, recipe composition, the semantic judge and user-confirmed
overrides.

Bundled data has its own terms: **BLS 4.0** (Max Rubner-Institut, CC BY 4.0) and **USDA FoodData
Central** (public domain / CC0) — see `resources/bls/NOTICE` and `resources/usda/NOTICE`.
Third-party dependency licences are listed in [NOTICE](NOTICE).
