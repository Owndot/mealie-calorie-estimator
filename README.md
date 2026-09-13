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

## Architecture and automatic workflow

Mealie recipe-created/updated webhook → authenticated recipe fetch → **one whole-recipe LLM normalization request** → SQLite cache → Open Food Facts for product foods → bundled USDA generic database → last-resort LLM nutrient estimate → deterministic arithmetic → nutrition PATCH to the same Mealie recipe.

The existing Fastify service, webhook setup, household tokens, manual-calorie protection, update hashes, on-demand endpoint and backfill are retained. Enable `LLM_ENABLED=true` with your configured OpenAI-compatible model to normalize German ingredient language, estimated package/piece quantities and food states. No per-recipe manual action is needed. If normalization fails, the existing ingredient interpreter attempts recovery.

LLMs normalize ingredients and provide last-resort per-100-g profiles; **all recipe arithmetic happens in code**. Each nutrient is multiplied by ingredient grams / 100, summed, then divided once by actual servings. A 2400 kcal recipe with `8 servings` becomes 300 kcal per serving; it never becomes an 8 g recipe. Original ingredients and yield are not rewritten.

SQLite caches names, aliases, per-100-g nutrients, source, confidence and timestamps. Compose mounts a persistent cache volume. Cached LLM estimates retain their original confidence. OFF scores product identity, brand, state, category and nutritional completeness; failures advance to other providers. The bundled 171-profile USDA database keeps OFF from being the only source. A provider interface permits additional databases.

Each ingredient reports provenance and estimated-quantity flags. Low confidence alone does not block valid nutrition. Unresolved ingredients are logged while the remaining calculation continues; the default partial policy preserves existing Mealie values. Nutrition and estimator metadata are updated by default; optional prior auto-tagging requires `AUTO_TAGS_ENABLED=true`.

See [the nutrition data contract](docs/nutrition.md) for validation, units, provider priority, partial-write behavior, cache limitations and test coverage.

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
       build: .
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
       volumes:
         - calorie-cache:/app/data
   volumes:
     calorie-cache:
   ```
2. Or run standalone
   ```bash
   docker compose up --build -d calorie-estimator
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
| `LLM_ENABLED` | `false` | Enable whole-recipe normalization, quantity estimates and last-resort nutrient fallback |
| `LLM_API_KEY` | — | API key for OpenAI-compatible endpoint |
| `LLM_BASE_URL` | `https://api.mistral.ai/v1` | LLM API base URL |
| `LLM_ENDPOINT_URL` | `/chat/completions` | LLM API endpoint path (supports OpenAI-compatible providers) |
| `LLM_MODEL` | `mistral-small-latest` | Model name |
| `LLM_NORMALIZE_RECIPE` | `true` | Normalize the full recipe first; false selects legacy recovery directly |
| `AUTO_TAGS_ENABLED` | `false` | Opt into previous auto-tagging behavior |
| `CACHE_DB_PATH` | `data/cache.db` | SQLite path; Compose uses `/app/data/cache.db` on its named volume |
| `OFF_CACHE_TTL` | `86400` | Cache expiry in seconds |
| `PARTIAL_ESTIMATE_POLICY` | `withhold` | Preserve nutrition for unresolved recipes; `fill-empty` permits partial writes to empty nutrition |
| `PINCH_GRAMS` | `0.25` | Legacy pinch mass, bounded to 0.05–0.5 g |
| `ESTIMATE_STRATEGY` | `all` | Estimation strategy: `all` (estimate every recipe) or `tagged` (only estimate recipes with the `ESTIMATE_TAG` tag) |
| `ESTIMATE_TAG` | `estimate` | Tag name to check when `ESTIMATE_STRATEGY=tagged` |
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
| `POST` | `/estimate` | On-demand estimation for a single recipe |
| `POST` | `/backfill` | Estimate nutrition for all existing recipes |

## Motivation

<!-- Add bit of context why the project has been created -->

Mealie stores nutrition only when entered by hand. Maintaining that for every recipe is tedious, so this service fills the gap automatically from USDA generic references, Open Food Facts and an optional LLM while leaving manual entries untouched.

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

### Build and test

```sh
npm ci
npm run typecheck
npm test
npm run build
docker build --target test -t mealie-calorie-estimator:test .
docker build -t mealie-calorie-estimator:local .
# On Linux with Docker, verify automatic processing and cache persistence:
node tests/docker-smoke.mjs mealie-calorie-estimator:local
```

Tests use fixtures/mocks and need no live API keys. The Docker `test` stage runs the full suite. The GitHub nutrition workflow also tests the production container against mock Mealie and LLM services, including a restart.

For deployment, copy `.env.example` to `.env`, set the Mealie token and existing LLM settings, then run `docker compose up --build -d calorie-estimator`. Keep the estimator on the same Docker network as Mealie. The supplied test profile remains available for development with a real Mealie container; production does not require it.
