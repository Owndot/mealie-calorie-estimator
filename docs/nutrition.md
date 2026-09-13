# Nutrition pipeline and data contract

The existing Fastify service receives Mealie Apprise webhooks, fetches the recipe with the existing household-aware token, estimates nutrition, and PATCHes the same recipe. `/estimate` and `/backfill` reuse the same estimator. No new application or manual per-recipe step is needed.

## Normalization

With `LLM_ENABLED=true` and the default `LLM_NORMALIZE_RECIPE=true`, `recipe-normalizer.ts` sends the complete ingredient list and cooking instructions in one OpenAI-compatible JSON request. Recipe yield, servings, nutrition, extras and API tokens are excluded from the ingredient data. The configured model receives names, structured quantities, units, notes and original text, including unparsed German ingredients.

The response is `{ "ingredients": [...] }`, preserving input indexes and original text. Every non-null row has `index`, `original`, `name`, `searchName`, `amount`, `unit`, `estimatedAmount`, `state`, `generic`, `brand`, `category` and `confidence`. Internal amounts are grams. The prompt converts volume to ingredient-specific mass, understands EL/TL, pinch, piece, bunch, clove, can and package quantities, and preserves dry/cooked/drained, brand and fat qualifiers. Unknown mass estimates must be marked. Code also marks every non-mass conversion as estimated, regardless of the model's flag.

Strict validation rejects arbitrary text, extra keys, changed coverage/indexes, invalid numbers, invented brands, conflicting explicit states and lost nutrition-changing qualifiers. A malformed row cannot invalidate its valid neighbors. Section headings may return null. Structured g/kg/mg/oz/lb quantities override LLM masses. Explicit leading g/kg/mg quantities in unparsed text also override model masses. Servings never scale ingredients.

Validated complete responses are cached by input, model, endpoint and interpretation/data versions; serving-only changes can reuse normalization. Failed or partially invalid responses are not cached. On request/validation failure, the existing semantic interpreter and quantity recovery are used. `LLM_NORMALIZE_RECIPE=false` explicitly selects that recovery path; disabling the LLM leaves local interpretation and database matching available.

## Nutrition providers

`NutritionProvider.resolve(context)` returns a per-100-g profile with provenance, confidence and timestamp, or null. Each provider contains its own search/selection; new providers can be inserted without modifying recipe arithmetic. Priority:

1. Shared local SQLite resolved-food cache.
2. Open Food Facts for branded/commercial or unresolved literal product names.
3. Existing bundled USDA generic database and deterministic water/salt profiles.
4. Additional optional providers can be inserted here through the interface (none configured by default).
5. Validated LLM per-100-g nutrient estimate as the final fallback.

Classified generic foods skip packaged-product searches, so plain rice uses USDA dry rice instead of an OFF ready meal. OFF evaluates up to ten results: exact normalized identity and brand/state compatibility are mandatory, category alignment and nutrient completeness rank compatible results. Incomplete core profiles, conflicting states and implausible nutrition are rejected. Network failures, malformed responses and provider exceptions advance to the next provider. OFF is not the sole database.

The bundled dataset contains 171 USDA SR Legacy profiles with FDC IDs, descriptions, aliases, nutrient composition and household portions. `src/nutrition-data/selection.json` and `scripts/import-usda.py` retain the existing reproducible import path. The [USDA SR Legacy archive](https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_sr_legacy_food_csv_2018-04.zip) is the original source. No new external generic-database credential is needed.

## Deterministic arithmetic and Mealie units

For each nutrient: `contribution = nutrientPer100g * ingredientGrams / 100`. Code sums contributions, then divides once by the actual serving count. The LLM never calculates recipe totals.

Structured positive `recipeServings` takes precedence. Otherwise the existing yield parser accepts numeric servings, including German `Portionen`; mass/volume yields are excluded. For 2400 kcal total and `recipeYield = "8 servings"`, per-serving calories are 300; the original ingredient masses and yield are unchanged. Missing usable servings produces a warning and no nutrition values.

Mealie receives per-serving numeric strings: calories in kcal; protein, carbohydrate, fat, fiber and sugars in grams; sodium and cholesterol in **milligrams**. OFF normalized sodium/cholesterol in grams are multiplied by 1000 exactly once. The existing [Mealie nutrition labels](https://github.com/mealie-recipes/mealie/blob/mealie-next/frontend/app/composables/recipes/use-recipe-nutrition.ts) define those units. Calories and sodium/cholesterol are rounded to integers; other fields use two decimals. The API schema does not require a nutrition `servingSize` field.

Carbohydrates follow the existing available-carbohydrate convention: USDA fiber is subtracted once by the importer. Unknown profile fields remain null; a nutrient with no known contributions is omitted. With mixed known/missing fields, the existing aggregation reports the known subtotal, so individual optional nutrient totals may be incomplete. Ingredient-level profiles expose missing values. No unknown value is synthesized by the final arithmetic.

Known household measures include approximately 13.5 g/EL olive oil, 7.8 g/EL flour, 6 g/TL salt, 1 g/TL dried thyme, 3 g/garlic clove and 110 g/medium onion. These are estimates, not exact weighed masses. The new normalization path estimates unknown densities with the LLM; legacy recovery retains its approximate liquid defaults. `PINCH_GRAMS` controls legacy pinch conversion (0.25 g default, valid range 0.05–0.5).

## Cache, provenance and failures

`CACHE_DB_PATH` defaults to `data/cache.db`. The existing sql.js SQLite database now also stores `resolved_food_cache`: versioned identity/state keys and a JSON record containing normalized name, aliases/search terms, all nutrients, original source, numeric confidence, timestamp, selected product and optional USDA ID. Cached estimates retain their original confidence; a cache hit does not make an LLM estimate exact. `OFF_CACHE_TTL` controls lookup expiry (86400 seconds by default). Existing OFF and interpretation caches remain available to the recovery path.

Docker Compose mounts `calorie-cache` at `/app/data`. Writes replace the file atomically, normally within five seconds, and SIGTERM/SIGINT flush it on shutdown. Abrupt process/host failure can lose the last five seconds of cache entries. Use one estimator process per cache file; sql.js does not coordinate multiple writers.

Logs and `EstimateResult` retain original ingredient name, gram mass, `estimatedAmount`, source, original cached source, timestamp, selected product/profile, interpretation/source/weight/final confidence and rejection reasons. Recipe logs summarize counts by source, total/per-serving kcal, serving count and warnings. LLM fallback is logged at warning level. Confidence values are policy scores, not calibrated probabilities. Low confidence alone does not block a valid normalized ingredient.

An unresolved ingredient does not stop calculation of the others. Existing partial-write safety remains: `PARTIAL_ESTIMATE_POLICY=withhold` (default) preserves Mealie nutrition when ingredient coverage is incomplete; `fill-empty` permits a partial write only when all existing nutrition fields are empty. Both keep unmatched details and warnings in estimator extras. This differs from a low-confidence ingredient that successfully resolves, which is included normally. Legacy unquantified to-taste seasoning may be omitted with a warning; whole-recipe normalization can instead estimate its quantity.

## Automatic updates and boundaries

Only nutrition and estimator-owned extras are written by default. Ingredient quantities/names, instructions, yield, text and user tags are untouched. Existing extras are merged. `AUTO_TAGS_ENABLED=true` explicitly enables the prior calorie/digestibility tag feature.

Hashes include calculation versions, ingredient inputs, serving inputs and relevant configuration, excluding output metadata and secrets. Completed inputs and unchanged partial webhook attempts are skipped to prevent recursive updates. Manual calories remain protected. Changed inputs, `/estimate` and `/backfill` retain existing retry behavior. No polling daemon is introduced; configure Mealie's Recipe Created/Updated notifier as before.

## Verification

```sh
npm ci
npm run typecheck
npm test
npm run build
docker build --target test -t mealie-calorie-estimator:test .
docker build -t mealie-calorie-estimator:local .
# Linux Docker host; uses host networking and temporary mock services, no real keys
node tests/docker-smoke.mjs mealie-calorie-estimator:local
```

The Docker test stage runs type checking and the complete mocked suite. CI also starts the production image against mock Mealie/LLM endpoints, verifies automatic authenticated fetch/PATCH, serving math, nutrition-only writes, webhook idempotency, and cache reuse after container restart. Live nutrition accuracy still depends on recipe wording, reference coverage, brand data and the configured model; the suite does not claim live-model accuracy.
