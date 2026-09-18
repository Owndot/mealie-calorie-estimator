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

## Product modes

The engine runs in three configurations. Nutrient values always come from a real database record
whenever one is selected — the mode changes how well ingredients are *understood*, not where the
numbers come from.

### Deterministic — no API key required

Runs entirely on the bundled data. No LLM, no external AI service, nothing to sign up for, fully
self-hostable and offline apart from Open Food Facts lookups for branded products.

- BLS 4.0, USDA and Open Food Facts remain the nutrient sources.
- The [Recipe Vocabulary](#recipe-vocabulary) covers known German and English language gaps —
  "Kurkuma" reaching the turmeric record, "Petersilie" meaning the leaf rather than the root.
- Resolution is deliberately conservative: where identity cannot be established safely the
  ingredient is left unresolved rather than matched to a plausible but different food. An
  ingredient you can see was skipped is recoverable; a confidently wrong one is not.

### AI-assisted — recommended for best matching accuracy

Optional. Set `LLM_ENABLED=true` with an API key for any OpenAI-compatible endpoint.

An LLM assists with *interpretation*, not with arithmetic: normalizing and translating ingredient
names, reading preparation states, and choosing between database records retrieval already found.
It does not normally replace a database record — when a record is selected, that record is still
the nutrient source. This handles free-text ingredient names, unusual phrasing and ambiguous
matches noticeably better than deterministic mode.

### LLM nutrient estimation — optional last resort

Distinct from AI-assisted *matching*. When no database record can be found for an ingredient at
all, the engine may generate an estimated nutrient value rather than leave the recipe incomplete.

Those values are **generated, not measured**, and stay identifiable: the ingredient is recorded as
`llm-nutrient`, and the recipe reports its evidence as `estimated` or `mixed` with the share of
calories that were generated. See [Automatic tagging](#automatic-tagging) and the provenance
extras.

It has its own switch, because it is the one LLM capability that invents numbers rather than
choosing among numbers somebody else measured:

```bash
LLM_ENABLED=true            # classification, translation, gram estimation, reranking, judge
LLM_NUTRIENT_ENABLED=false  # …but no generated nutrient values
```

`LLM_NUTRIENT_ENABLED` defaults to `true`, so `LLM_ENABLED` on its own behaves exactly as before.
Setting it to `false` keeps every other model-assisted feature and leaves an ingredient no database
could resolve **unresolved** — a visible gap in coverage rather than a `complete` recipe whose
calories are partly invented. Useful when you would rather see what the databases genuinely cover.

## Recipe Vocabulary

```
ingredient -> normalization -> recipe vocabulary -> resolver -> BLS / USDA / OFF
```

A small curated map from what people write in recipes to what the databases call it, used before
the resolver runs.

- **Curated and sparse.** It is not an attempt to enumerate food — it exists to prevent known
  identity failures, and each entry was added because a real recipe corpus showed that term
  resolving wrongly or not at all.
- **Language-aware.** Separate German and English vocabularies.
- **Exact matching in 1.2.** A term either matches a curated entry or continues through the normal
  resolver unchanged; there is no fuzzy or typo matching yet.
- **It records uncertainty too.** Genuinely ambiguous words such as `Bohnen` are marked as such, so
  the engine declines to guess instead of picking whichever bean sorts first.

Unknown vocabulary behaves exactly as it did before.

## Features

**Automatic, once connected**

- **Processes recipes on their own** — Mealie notifies the engine whenever a recipe is created or
  updated, and it does the rest. No per-recipe API calls.
- **Calculates whole-recipe nutrition** from Mealie's structured quantities and units (German units
  included), dividing by servings exactly once.
- **Resolves ingredients against real food records** — bundled BLS 4.0 and USDA databases first,
  Open Food Facts for branded products, with hard semantic gates that reject a wrong-but-similar
  food instead of using it.
- **Tags every estimated recipe** with a calorie band and a digestibility band — see
  [Automatic tagging](#automatic-tagging).
- **Records provenance per ingredient**: which database, which record id, confidence, and what it
  could *not* satisfy.
- **Protects manual nutrition** and prevents webhook loops, so re-running is always safe.

**Optional**

- **Backfill** every existing recipe in one request.
- **Your own Mealie recipes as a nutrition source** — a homemade curry paste resolves from the
  recipe you already wrote (on by default).
- **LLM assistance** for normalizing ingredient names, reading preparation states and choosing
  between real records — off by default, recommended for best matching accuracy, and never used to
  produce a nutrient value when a real record exists. See [Product modes](#product-modes).
- **User-confirmed overrides** for genuinely ambiguous foods: bind one ingredient to one real
  record, once.

## How it works

Once the Mealie notifier is connected, this happens by itself:

```
recipe created or updated in Mealie
  └─ Mealie sends a notification to the engine
     └─ ingredients are normalized and resolved against real food records
        └─ nutrition is calculated in code, then divided by servings exactly once
           └─ nutrition is written back to the recipe
              └─ calorie + digestibility tags and provenance are added
```

The engine writes **only** nutrition, its own `calorie_estimator_*` extras, and its own tags. Your
ingredients, quantities, units, instructions, images and your own tags are never modified.

Re-running is safe by design. An unchanged recipe is a no-op — the engine fingerprints the
ingredients, so a webhook it triggered itself settles immediately instead of looping. Nutrition you
entered by hand is detected and preserved rather than overwritten.

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

The [Recipe Vocabulary](#recipe-vocabulary) sits *before* this chain. It supplies identity, never
nutrients: it can tell the resolver that "Kurkuma" means turmeric, and the record still comes from
the table above.

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

## Quick Start

Three steps. **Step 2 is the one that makes everything automatic** — without the Mealie notifier the
engine runs but nothing ever reaches it.

### 1. Start the engine

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

### 2. Connect the Mealie notifier

This is what makes recipes process themselves. Skip it and nothing happens automatically.

In Mealie, go to **Settings → Notifiers → Create** and set:

- **Apprise URL**: `json://nutrition-engine:8000/webhook`
  (use the engine's container name and port as Mealie sees them)
- **Events**: enable **Recipe Created** and **Recipe Updated**. Leave the rest off.

Save it, then create or edit any recipe — nutrition and tags appear on their own within a few
seconds.

### 3. Verify

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

and check the recipe in Mealie: it should now have nutrition values, two auto-tags, and a
`calorie_estimator_provenance` extra naming the record behind every ingredient.

### Already have recipes?

Run the backfill once and the whole library is processed with the same rules:

```bash
curl -X POST http://127.0.0.1:8000/backfill
```

## Configuration

**Only two variables are required.** Everything else has a working default, and every supported
variable is documented in [`.env.example`](.env.example).

| Variable | Required | Notes |
|---|---|---|
| `MEALIE_URL` | **yes** | e.g. `http://mealie:9000` |
| `MEALIE_API_TOKEN` | **yes** | a dedicated service-account token |
| `OFF_LANGUAGE` | no | Open Food Facts search language, default `de` |
| `ESTIMATE_STRATEGY` | no | `all` (default) or `tagged` — see [Optional and advanced](#optional-and-advanced) |
| `LLM_ENABLED`, `LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL` | no | any OpenAI-compatible endpoint; **off** by default. Leave unset to run deterministically with no API key — see [Product modes](#product-modes) |
| `LLM_JUDGE_ENABLED` | no | semantic judge, **off** by default |
| `OVERRIDE_ADMIN_TOKEN` | no | enables the override API; unset means those routes do not exist |
| `CACHE_DB_PATH`, `OVERRIDES_DB_PATH` | no | default to `data/` |
| `LOG_LEVEL` | no | `info`; use `debug` for per-ingredient detail |

Automatic tagging has no setting — see [Automatic tagging](#automatic-tagging).

### Persistence and backups

Both databases live in `/app/data`:

| File | Rebuildable? | Notes |
|---|---|---|
| `cache.db` | **yes** | provider matches, LLM classifications, judge decisions. Safe to delete; it refills. |
| `overrides.db` | **no** | the records you deliberately chose. **Back this up.** |

Keep `/app/data` on a named volume or bind mount. Both survive container recreation.

## Automatic tagging

Every estimated recipe is tagged in Mealie with **one calorie tag and one digestibility tag**. This
is always on — there is no setting to disable it. Tags are created in Mealie the first time they are
needed.

**Calorie tags**, from calories *per serving*:

| Tag | Per serving |
|---|---|
| `Calories:Light` | under 350 kcal |
| `Calories:Moderate` | 350 – 600 kcal |
| `Calories:Hearty` | 601 – 850 kcal |
| `Calories:Heavy` | over 850 kcal |

**Digestibility tags**, from the share of calories coming from fat:

| Tag | Criteria |
|---|---|
| `Digest:Easy` | fat under 30 % of calories **and** 600 kcal or less per serving |
| `Digest:Slow` | fat 40 % or more of calories |
| `Digest:Moderate` | in between — e.g. fat 30–40 %, or low-fat but calorie-dense |
| `Digest:Unknown` | fat or calorie data missing |

**Your own tags are never touched.** The engine remembers which tags it applied (in the
`calorie_estimator_tags` extra) and replaces only those on the next run. A recipe that already has
nutrition but is missing its tags — after an upgrade, say — gets them back without being
re-estimated.

The digestibility bands are a rough guide from macronutrient ratios, not a medical or dietary claim.

## User-confirmed overrides

**You do not need these for normal use.** Ingredients resolve automatically; overrides exist for the
few that cannot be resolved honestly by any search.

Some ambiguity is genuine. Asked which of four real light mayonnaises a recipe means, the correct
machine answer is "I don't know" — and the engine says so by flagging the unsatisfied property
rather than guessing. When an ingredient is ambiguous like that, or keeps resolving to the wrong
food, you can bind it **once** to a real record — from BLS, the local USDA database, Open Food Facts
or one of your own Mealie recipes — and the engine remembers your choice from then on.

An override stores a **pointer to that record**, never a copy of its numbers: the nutrients are
re-read from the source every time, so the binding cannot silently go stale, and a target that can
no longer be loaded falls back to normal resolution instead of serving something outdated.

Set `OVERRIDE_ADMIN_TOKEN` to enable the management API. Preview, create, list, delete, suggestions,
`curl` examples and the security notes are in **[`docs/OVERRIDES.md`](docs/OVERRIDES.md)**.

## Optional and advanced

| Capability | How to enable | Notes |
|---|---|---|
| **Backfill** | `curl -X POST http://127.0.0.1:8000/backfill` | walks every recipe once, applying the same rules; safe to re-run |
| **Force one recipe** | `curl -X POST "http://127.0.0.1:8000/estimate/<slug>?force=true"` | recalculates even if unchanged; still will not overwrite manual nutrition |
| **Overwrite manual nutrition** | add `&overrideManual=true` | the only way to replace nutrition a person entered — deliberately separate from `force` |
| **Estimate only tagged recipes** | `ESTIMATE_STRATEGY=tagged`, `ESTIMATE_TAG=estimate` | default is `all` |
| **Per-household tokens** | `MEALIE_API_TOKEN_<HOUSEHOLD_ID>` | for multi-household Mealie; non-alphanumerics in the id become `_` |
| **Your recipes as a source** | `MEALIE_RECIPE_SOURCE_ENABLED` | **on** by default |
| **LLM assistance** | `LLM_ENABLED=true` + `LLM_API_KEY` | any OpenAI-compatible endpoint |
| **Semantic judge** | `LLM_JUDGE_ENABLED=true` | off by default; needs the LLM |
| **Overrides API** | `OVERRIDE_ADMIN_TOKEN` | unset means the routes do not exist |

### Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | liveness |
| `POST` | `/webhook` | Mealie notifier target |
| `POST` | `/estimate/:slug` | recalculate one recipe |
| `POST` | `/backfill` | recalculate in bulk |
| `*` | `/overrides…` | override management — see [`docs/OVERRIDES.md`](docs/OVERRIDES.md) |

## Updating

```bash
docker compose pull nutrition-engine && docker compose up -d nutrition-engine
```

Your data volume is untouched. If a release changes matching behaviour, the notes say so.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `getaddrinfo EAI_AGAIN mealie` | the containers are not on the same Docker network |
| Recipes never update | the Mealie notifier is not enabled, or not pointed at `/webhook` — see [Quick Start step 2](#2-connect-the-mealie-notifier) |
| Nutrition appears but no tags | the recipe was estimated by an older version; re-save it or run `/backfill` — tags are re-added without re-estimating |
| Only some recipes are processed | `ESTIMATE_STRATEGY=tagged` is set, so only recipes carrying `ESTIMATE_TAG` are estimated |
| `usdaLocalEnabled:false` at startup | the image was built without `resources/` — rebuild |
| Nutrition looks wrong for one ingredient | read its `calorie_estimator_provenance` row; if `unmetAttributes` is non-empty the engine is telling you it could not satisfy a stated property — a good override candidate |
| Judge never runs | `LLM_JUDGE_ENABLED` is off by default, and requires `LLM_ENABLED` + a key |
| Override API returns 401/404 | `OVERRIDE_ADMIN_TOKEN` unset (404) or wrong (401) |

Set `LOG_LEVEL=debug` for per-ingredient resolution detail.

## Limitations

- German is the validated language; English is best-effort (see above)
- Deterministic and AI-assisted modes do not match equally well: deterministic mode resolves fewer
  ingredients and declines more often by design. No LLM is required to run the engine
- Recipe Vocabulary matching is exact in 1.2 — fuzzy/typo matching and composite-food handling
  (spice blends, prepared pastes) are not included
- Open Food Facts is live data: products appear and disappear, and search results drift
- LLM-estimated ingredients are marked `llm-nutrient` and are estimates, not measurements
- Unknown is not zero — unresolved ingredients are withheld or flagged, never silently counted as 0
- Nutrition is computed for whole recipes and divided by servings exactly once; per-portion accuracy
  depends on Mealie's `recipeServings` being correct

## Detailed documentation

| Document | Covers |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | pipeline, provider order, semantic gates, provenance, recipe vocabulary |
| [`docs/OVERRIDES.md`](docs/OVERRIDES.md) | the override API in full, key design, backups |
| [`docs/CACHING.md`](docs/CACHING.md) | cache layers, TTLs, invalidation |
| [`docs/RELEASING.md`](docs/RELEASING.md) | how a version is cut |

## Development

```bash
npm install
npm run dev          # watch mode
npm test             # 870 tests
npm run typecheck
npm run build
```

Tests run against the **real** bundled BLS and USDA databases — a matching change that breaks a real
food fails the suite.

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
