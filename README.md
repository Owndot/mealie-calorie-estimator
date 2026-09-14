mealie-calorie-estimator
===
[![GitHub Release](https://img.shields.io/github/v/tag/timo-reymann/mealie-calorie-estimator?label=version)](https://github.com/timo-reymann/mealie-calorie-estimator/releases)
[![Docker Pulls](https://img.shields.io/docker/pulls/timoreymann/mealie-calorie-estimator?style=flat)](https://hub.docker.com/r/timoreymann/mealie-calorie-estimator)
[![GitHub all releases download count](https://img.shields.io/github/downloads/timo-reymann/mealie-calorie-estimator/total)](https://github.com/timo-reymann/mealie-calorie-estimator/releases)
[![LICENSE](https://img.shields.io/github/license/timo-reymann/mealie-calorie-estimator)](https://github.com/timo-reymann/mealie-calorie-estimator/blob/main/LICENSE)
[![CircleCI](https://circleci.com/gh/timo-reymann/mealie-calorie-estimator.svg?style=shield)](https://app.circleci.com/pipelines/github/timo-reymann/mealie-calorie-estimator)
[![Renovate](https://img.shields.io/badge/renovate-enabled-green?logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAzNjkgMzY5Ij48Y2lyY2xlIGN4PSIxODkuOSIgY3k9IjE5MC4yIiByPSIxODQuNSIgZmlsbD0iI2ZmZTQyZSIgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoLTUgLTYpIi8+PHBhdGggZmlsbD0iIzhiYjViNSIgZD0iTTI1MSAyNTZsLTM4LTM4YTE3IDE3IDAgMDEwLTI0bDU2LTU2YzItMiAyLTYgMC03bC0yMC0yMWE1IDUgMCAwMC03IDBsLTEzIDEyLTktOCAxMy0xM2ExNyAxNyAwIDAxMjQgMGwyMSAyMWM3IDcgNyAxNyAwIDI0bC01NiA1N2E1IDUgMCAwMDAgN2wzOCAzOHoiLz48cGF0aCBmaWxsPSIjZDk1NjEyIiBkPSJNMzAwIDI4OGwtOCA4Yy00IDQtMTEgNC0xNiAwbC00Ni00NmMtNS01LTUtMTIgMC0xNmw4LThjNC00IDExLTQgMTUgMGw0NyA0N2M0IDQgNCAxMSAwIDE1eiIvPjxwYXRoIGZpbGw9IiMyNGJmYmUiIGQ9Ik04MSAxODVsMTgtMTggMTggMTgtMTggMTh6Ii8+PHBhdGggZmlsbD0iIzI1YzRjMyIgZD0iTTIyMCAxMDBsMjMgMjNjNCA0IDQgMTEgMCAxNkwxNDIgMjQwYy00IDQtMTEgNC0xNSAwbC0yNC0yNGMtNC00LTQtMTEgMC0xNWwxMDEtMTAxYzUtNSAxMi01IDE2IDB6Ii8+PHBhdGggZmlsbD0iIzFkZGVkZCIgZD0iTTk5IDE2N2wxOC0xOCAxOCAxOC0xOCAxOHoiLz48cGF0aCBmaWxsPSIjMDBhZmIzIiBkPSJNMjMwIDExMGwxMyAxM2M0IDQgNCAxMSAwIDE2TDE0MiAyNDBjLTQgNC0xMSA0LTE1IDBsLTEzLTEzYzQgNCAxMSA0IDE1IDBsMTAxLTEwMWM1LTUgNS0xMSAwLTE2eiIvPjxwYXRoIGZpbGw9IiMyNGJmYmUiIGQ9Ik0xMTYgMTQ5bDE4LTE4IDE4IDE4LTE4IDE4eiIvPjxwYXRoIGZpbGw9IiMxZGRlZGQiIGQ9Ik0xMzQgMTMxbDE4LTE4IDE4IDE4LTE4IDE4eiIvPjxwYXRoIGZpbGw9IiMxYmNmY2UiIGQ9Ik0xNTIgMTEzbDE4LTE4IDE4IDE4LTE4IDE4eiIvPjxwYXRoIGZpbGw9IiMyNGJmYmUiIGQ9Ik0xNzAgOTVsMTgtMTggMTggMTgtMTggMTh6Ii8+PHBhdGggZmlsbD0iIzFiY2ZjZSIgZD0iTTYzIDE2N2wxOC0xOCAxOCAxOC0xOCAxOHpNOTggMTMxbDE4LTE4IDE4IDE4LTE4IDE4eiIvPjxwYXRoIGZpbGw9IiMzNGVkZWIiIGQ9Ik0xMzQgOTVsMTgtMTggMTggMTgtMTggMTh6Ii8+PHBhdGggZmlsbD0iIzFiY2ZjZSIgZD0iTTE1MyA3OGwxOC0xOCAxOCAxOC0xOCAxOHoiLz48cGF0aCBmaWxsPSIjMzRlZGViIiBkPSJNODAgMTEzbDE4LTE3IDE4IDE3LTE4IDE4ek0xMzUgNjBsMTgtMTggMTggMTgtMTggMTh6Ii8+PHBhdGggZmlsbD0iIzk4ZWRlYiIgZD0iTTI3IDEzMWwxOC0xOCAxOCAxOC0xOCAxOHoiLz48cGF0aCBmaWxsPSIjYjUzZTAyIiBkPSJNMjg1IDI1OGw3IDdjNCA0IDQgMTEgMCAxNWwtOCA4Yy00IDQtMTEgNC0xNiAwbC02LTdjNCA1IDExIDUgMTUgMGw4LTdjNC01IDQtMTIgMC0xNnoiLz48cGF0aCBmaWxsPSIjODgzMTAwIiBkPSJNMjQwIDI0OGwtNyA3Yy00IDQtMTEgNC0xNiAwbC02LTdjNCA1IDExIDUgMTUgMGw3LTdjNC01IDQtMTIgMC0xNnoiLz48L3N2Zz4=)](https://github.com/timo-reymann/mealie-calorie-estimator)
[![codecov](https://codecov.io/gh/timo-reymann/mealie-calorie-estimator/graph/badge.svg?token=lTQRwxnxYl)](https://codecov.io/gh/timo-reymann/mealie-calorie-estimator)
[![Quality Gate Status](https://sonarcloud.io/api/project_badges/measure?project=timo-reymann_mealie-calorie-estimator&metric=alert_status)](https://sonarcloud.io/summary/new_code?id=timo-reymann_mealie-calorie-estimator)
[![Maintainability Rating](https://sonarcloud.io/api/project_badges/measure?project=timo-reymann_mealie-calorie-estimator&metric=sqale_rating)](https://sonarcloud.io/summary/new_code?id=timo-reymann_mealie-calorie-estimator)
[![Security Rating](https://sonarcloud.io/api/project_badges/measure?project=timo-reymann_mealie-calorie-estimator&metric=security_rating)](https://sonarcloud.io/summary/new_code?id=timo-reymann_mealie-calorie-estimator)

<p align="center">
    <img width="300" src="./.github/images/logo.png">
    <br />
    Automatic nutrition estimation for recipes hosted on a <a href="https://mealie.io/">Mealie</a> instance
</p>

## Features

<!-- List features as bullet points -->

- Routing-aware provider chain: USDA FoodData Central (optional, generic foods) and [Open Food Facts](https://world.openfoodfacts.org/) (branded/product foods) — OFF is never queried for a plain generic ingredient, and there is no hand-authored local nutrition database standing in as an "authoritative" source
- Brand detection is evidence-based only: a brand is used only when it's explicitly present in the structured `food.name`, never inferred from general knowledge
- Sanity-checks every candidate (implausible kcal, salt/sodium unit mistakes, macro inconsistencies) and rejects/falls through to the next provider rather than trusting it blindly
- One whole-recipe LLM batch request for ingredient normalization (never one call per ingredient); per-ingredient LLM calls remain only for unresolved unit gram estimates and a final per-food nutrient fallback
- Food-specific unit conversion — 1 EL/TL/ml of oil, flour, sugar, honey etc. resolve to different gram weights (ml/l are volume units, never assumed to be 1g/ml); German units (EL, TL, Prise, Dose, Glas, Bund, Packung, Päckchen, Becher, Tasse, Stange, Zehe, Stück) are supported alongside metric/imperial
- Recipes with a significant unresolved ingredient are marked withheld rather than written with misleadingly "complete" numbers; minor unresolved seasonings are marked partial and don't block the rest
- Skips re-estimation via a SHA256 ingredient hash, preserves manually entered calories (including nutrition hand-edited *after* an earlier estimate, detected via a fingerprint of the values the estimator last wrote), and supports an explicit force-recalculate endpoint that still protects manual entries unless overridden
- Webhook, on-demand, and bulk backfill entry points, all sharing one estimation pipeline
- **Auto-tags** recipes with calorie range and digestibility tags

## Purpose

This small service enriches [Mealie](https://mealie.io/) (self-hosted recipe manager) with nutritional data by:

1. **Listening for webhooks** triggered when a recipe is created or updated.
2. **Resolving ingredients** from structured Mealie data only (`food.name` / `quantity` / `unit` — `originalText` is never read) through a routing-aware provider chain, with sanity checks on every candidate.
3. **Patching nutrition** back into Mealie's nutrition fields, dividing the whole-recipe total by `recipeServings` exactly once.

Unit conversion prioritizes Mealie's own structured conversion metadata (mass units only — a structured `standardUnit` of ml/l still requires food density, exactly like priority 3 below), then deterministic mass-unit conversion (g/kg/mg/oz/lb), then food-specific density (EL/TL/cup/ml/l — 200ml water and 200ml olive oil are *not* the same weight, and an unrecognized liquid never silently defaults to water density), then known piece/package weights (Stück/Dose/Glas/...), and only falls back to a bounded LLM gram estimate when nothing else resolves it. A SHA256 hash of the ingredients skips re-estimation when nothing changed, and manually entered calories are preserved unless explicitly overridden.

### Provider strategy

Ingredients are routed as **generic** or **branded** based on evidence-based classification (a brand is only used when the structured food name explicitly contains it):

- **Generic route:** cache → USDA FoodData Central (only if `USDA_API_KEY` is set) → LLM (if enabled) as the final fallback. Open Food Facts is never queried here. There is intentionally **no hand-authored local nutrition dataset** in this chain — a small built-in table of kcal/macro values would not be a trustworthy, reproducible nutrition source, so when USDA is unconfigured and the LLM is disabled, a generic ingredient honestly resolves to nothing rather than a fabricated number.
- **Branded route:** cache → Open Food Facts (ranked candidates, obvious mismatches like "ginger" vs "ginger ale" rejected) → the same generic (USDA) fallback → LLM last.

A local dataset may still carry deterministic **unit/density/piece-weight metadata** (see `src/services/food-density.ts`) — e.g. "1 EL olive oil ≈ 13.6g" or "1 Stück egg ≈ 53g" are culinary/physical constants, not nutrition facts, and are fine to hand-author and document. That is separate from, and must never substitute for, an actual nutrition provider.

`BLS_LOCAL_IMPORT_PATH` is a reserved config slot for a future local/licensed generic **nutrition** dataset (such as BLS): it is **not yet implemented** — no BLS data is bundled, redistributed, or read by this project pending a licensing review, and setting the variable currently has no effect. It exists so a local-import provider can be added later without a config/env break.

### Auto-Tagging

Every estimated recipe gets up to two auto-tags applied in Mealie: one for calorie range and one for digestibility.

**Calorie tags** (per serving):

| Tag | Range (kcal) |
|---|---|
| `Calories:Light` | < 350 |
| `Calories:Moderate` | 350 – 600 |
| `Calories:Hearty` | 600 – 850 |
| `Calories:Heavy` | > 850 |

**Digestibility tags** (based on macronutrient ratios):

| Tag | Criteria |
|---|---|
| `Digest:Easy` | fat < 30% of calories AND kcal ≤ 600 |
| `Digest:Slow` | fat ≥ 40% of calories |
| `Digest:Moderate` | anything in between (e.g. fat 30–40%, or low-fat but calorie-dense) |
| `Digest:Unknown` | missing fat or calorie data |

The digestibility heuristic relies on per-serving fat and calorie data — high fat indicates slow digestion, low fat with moderate calories indicates a lighter meal.

Tags are created automatically in Mealie when first needed. On re-estimation, old auto-tags are replaced but user-applied tags are preserved. If a recipe already has nutrition data but is missing auto-tags (e.g. after upgrading), they are added without re-estimating.

## Installation

It's recommended to install it next to your Mealie instance using docker-compose.

### Prerequisites

- A Mealie service account with an API token (`Settings > Users > Create User`)

1. Configure the estimator next to mealie
   ```yaml
   services:
     mealie:
       # mealie configuration
     calorie-estimator:
       image: timoreymann/mealie-calorie-estimator:latest
       container_name: mealie-calorie-estimator
       restart: unless-stopped
       depends_on:
         - mealie
       environment:
         MEALIE_URL: http://mealie:9000
         MEALIE_API_TOKEN: ${MEALIE_API_TOKEN}
         OFF_LANGUAGE: de
         LLM_ENABLED: ${LLM_ENABLED:-false}
         LLM_API_KEY: ${LLM_API_KEY:-}
   ```
2. Or run standalone
   ```bash
   docker compose up -d
   ```

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `MEALIE_URL` | `http://mealie:9000` | Mealie instance URL |
| `MEALIE_API_TOKEN` | — | **Required.** Default Mealie service account token. Used unless a per-household token matches |
| `MEALIE_API_TOKEN_<HOUSEHOLD_ID>` | — | Optional per-household token override. Set e.g. `MEALIE_API_TOKEN_my_household` to use a different token for recipes in that household. Non-alphanumeric characters in the household ID are replaced with `_` for lookup (e.g. a UUID `f0d4ec80-a7ae-4315-8c43-a3e4ed0ca01f` becomes `MEALIE_API_TOKEN_f0d4ec80_a7ae_4315_8c43_a3e4ed0ca01f`) |
| `OFF_LANGUAGE` | `de` | Open Food Facts search language(s) |
| `OFF_SEARCH_BASE_URL` | `https://search.openfoodfacts.org` | Open Food Facts search API base URL |
| `OFF_BASE_URL` | `https://world.openfoodfacts.org` | Open Food Facts base URL |
| `OFF_MAX_RETRIES` | `3` | Retries for transient OFF search errors (429/5xx) |
| `OFF_RETRY_BACKOFF_MS` | `500` | Base backoff between retries (doubles each attempt) |
| `USDA_API_KEY` | — | Optional. Enables the USDA FoodData Central generic-route fallback provider; omitted entirely from the provider chain when unset (no dummy placeholder) |
| `USDA_BASE_URL` | `https://api.nal.usda.gov/fdc/v1` | USDA FoodData Central base URL |
| `USDA_RATE_LIMIT` | `10` | USDA requests per minute |
| `BLS_LOCAL_IMPORT_PATH` | — | Reserved for a future local/licensed generic dataset (e.g. BLS). **Not yet implemented** — has no effect today |
| `LLM_ENABLED` | `false` | Enable the LLM: one whole-recipe batch normalization request, plus narrowly-scoped per-ingredient gram/nutrient fallback |
| `LLM_API_KEY` | — | API key for OpenAI-compatible endpoint |
| `LLM_BASE_URL` | `https://api.mistral.ai/v1` | LLM API base URL |
| `LLM_ENDPOINT_URL` | `/chat/completions` | LLM API endpoint path (supports OpenAI-compatible providers) |
| `LLM_MODEL` | `mistral-small-latest` | Model name |
| `ESTIMATE_STRATEGY` | `all` | Estimation strategy: `all` (estimate every recipe) or `tagged` (only estimate recipes with the `ESTIMATE_TAG` tag) |
| `ESTIMATE_TAG` | `estimate` | Tag name to check when `ESTIMATE_STRATEGY=tagged` |
| `CACHE_DB_PATH` | `data/cache.db` | SQLite cache file path |
| `CACHE_MATCH_TTL` | `604800` (7 days) | TTL in seconds for successful provider matches |
| `CACHE_MISS_TTL` | `86400` (1 day) | TTL in seconds for negative/miss results (avoids repeat rate-limited lookups) |
| `CACHE_LLM_TTL` | `43200` (12 hours) | TTL in seconds for LLM gram/nutrient estimates (least authoritative, shortest-lived) |
| `PORT` | `8000` | Server port |
| `LOG_LEVEL` | `info` | Pino log level |

See [`.env.example`](./.env.example) for the full list, including rate-limit and cache tuning.

## Usage

1. Navigate to your Mealie instance
2. Go to `Settings > User Settings > Notifiers`
3. Click `Create`
4. Fill out the form
    - **Apprise URL**: `json://calorie-estimator:8000/webhook`
    - **Events**: `Recipe Created`, `Recipe Updated`
5. Create or update a recipe — nutrition is estimated and patched back automatically

### Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Health check |
| `POST` | `/webhook` | Apprise webhook for recipe created/updated events |
| `POST` | `/estimate/:slug` | On-demand estimation for a single recipe. Query params: `force=true` bypasses the unchanged-ingredients skip and re-estimates (never overwrites manually-entered nutrition by itself); `overrideManual=true` (used together with `force=true`) is the separate, explicit confirmation required to overwrite a genuinely manual entry |
| `POST` | `/backfill` | Estimate nutrition for all existing recipes (never forces, never overrides manual entries) |

Recipe nutrition estimated by this service is marked with `extras.calorie_estimator_status` (`complete`, `partial`, or `withheld`) and `extras.calorie_estimator_provenance` (per-ingredient source/confidence), so estimator output is always distinguishable from a manually-entered value and from a low-confidence guess. `extras.calorie_estimator_nutrition_fingerprint` records a hash of the exact values the estimator last wrote; if a recipe's nutrition no longer matches that fingerprint on a later run (even though the ingredient hash is unchanged), it's treated as hand-edited and protected the same way a never-estimated manual entry is — not silently overwritten.

## Motivation

<!-- Add bit of context why the project has been created -->

Mealie stores nutrition only when entered by hand. Maintaining that for every recipe is tedious, so this service fills the gap automatically from Open Food Facts (and an optional LLM) while leaving manual entries untouched.

## Contributing

Contributions are welcome, whether it's:

- Reporting a bug
- Discussing the current state of the configuration
- Submitting a fix
- Proposing new features

## Development

### Requirements

<!-- Delete the ones not required -->

- [Node.js](https://nodejs.org/) 22+
- [Docker](https://docs.docker.com/get-docker/)

### Test

<!-- Add testing instructions -->

```sh
docker compose --profile test up -d
npm test
```

The test profile starts Mealie (SQLite), a mock Open Food Facts server, and the estimator.

### Build

<!-- Add building instructions -->

```sh
npm run build
```
