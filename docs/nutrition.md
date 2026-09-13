# Nutrition estimation: units, preparation and provenance

## Unit contract

Every `NutrientSet` / `NutrientProfilePer100g` describes **100 g edible food**:

- Energy: kcal.
- Protein, available carbohydrate, fats, fiber and sugar: grams.
- Sodium and cholesterol: **milligrams**.
- `null` means unknown, distinct from a measured zero.

`RecipeNutrientTotals` and `PerServingNutrition` use absolute quantities with explicit names (`kcal`, `proteinG`, `sodiumMg`, etc.). The estimator sums contributions as `profile × ingredient grams / 100`, then divides totals by servings once. No intermediate rounding is performed. Mealie output rounds kcal, sodium mg and cholesterol mg to integers, and macro grams to two decimals. JSON strings use plain numeric notation, not locale-formatted thousands separators.

The legacy `totalNutrients` and `perServingNutrients` fields remain available for API compatibility, but their `Per100g` suffixes are deprecated when they hold totals. Their sodium/cholesterol values now consistently mean mg. External consumers relying on the old, inconsistent units must update.

### Carbohydrate convention (EU/German)

Internal `carbsPer100g` and Mealie `carbohydrateContent` use the European/German nutrition-label convention: available carbohydrate excluding dietary fiber. Fiber is tracked separately as `fiberPer100g` / `fiberContent`.

This matters for foods with very high fiber and low digestible carbohydrate, such as curry powder: the checked-in USDA entry stores `carbsPer100g = 2.63` and `fiberPer100g = 53.2`, not a double-subtracted zero or a negative value. The importer normalizes USDA `carbohydrate by difference` by subtracting fiber once, and OFF `carbohydrates_100g` is treated as already available carbohydrate rather than being reduced again by `fiber_100g`.

The LLM nutrient prompt uses the same rule: `carbs = available carbohydrate excluding fiber`, `fiber = dietary fiber separately`, and `sugar` remains a subset of available carbohydrate.

### Confirmed sodium/cholesterol bug

[OFF's normalized nutrient schema](https://openfoodfacts.github.io/documentation/docs/Product-Opener/schemas/schemas/product_nutrition/) defines weight-based `_100g` values in grams, including sodium and cholesterol. Contributor `_unit` fields must not be applied again to those normalized values. [Mealie's frontend unit labels](https://github.com/mealie-recipes/mealie/blob/mealie-next/frontend/app/composables/recipes/use-recipe-nutrition.ts) use milligrams for both API fields. The previous code copied OFF grams straight to those fields and allowed the LLM to choose unspecified units.

OFF values are now multiplied by 1000 exactly once, at ingestion. If sodium is missing but salt is supplied, sodium is calculated as OFF salt / 2.5, then converted to mg. Per-100ml OFF profiles are divided by a known ingredient density to establish a per-100g basis; explicitly per-100ml profiles without known density are rejected.

For example, OFF sodium `0.4` g/100 g becomes `400` mg/100 g. A 200 g ingredient contributes 800 mg total, or 400 mg each for two servings. It cannot become 400 g through this conversion. The same boundary applies to cholesterol.

The old mismatch is established from code. The exact reported 20,913 mg recipe value cannot be reconstructed without its original ingredients, matched products, cached values and LLM responses. Old OFF values alone were generally understated by 1000; arbitrary LLM units and bad food/weight matches could also cause severe overestimates. Do not interpret a German display of `20.913 mg` as a small decimal quantity.

## Source selection

1. Interpret the food before choosing nutrients. Known normalization and exact database identities stay deterministic. When identity or notes remain unresolved and LLM is enabled, a **classification-only** request supplies canonical English food, preparation state, category, generic/brand status and interpretation confidence. It never asks for nutrients or grams. Existing German aliases are fast paths, not the vocabulary boundary.
2. Plain salt and water use deterministic composition. Other generic foods use the bundled USDA database before any OFF lookup. Matching checks normalized whole identity tokens, English synonyms, limited one-character typos in long tokens, and state compatibility. Close competing candidates are rejected. No token may be discarded to turn oil, seeds, leaves, drinks, sauces or prepared foods into another food. The semantic translation happens in classification; the local scorer is intentionally conservative rather than an embedding nearest-neighbor search.
3. Classified generic foods without a trustworthy state-specific reference go directly to validated LLM nutrition fallback; they do not search packaged OFF products. Branded/commercial products use OFF, checking brand against product name/brand metadata as well as food identity and state. If classification is disabled/unavailable by configuration, unresolved names retain the strict literal OFF path for backward compatibility. A classification attempted but rejected for low confidence does **not** take that path.
4. LLM nutrient fallback remains per 100 g, with explicit kcal/g/mg units, bounds/consistency checks and JSON-null failure. Its source/confidence is `LLM`/`low`. Missing or uncertain ingredients trigger the existing partial-write policy. Unitless spice blends still have unknown weight.

Each ingredient reports `interpretationConfidence`, `sourceConfidence` and `finalMatchConfidence`, plus `weightConfidence` for matched ingredients. The final confidence is the minimum of identity, source and weight confidence. These are conservative policy scores, **not calibrated probabilities**: classification requires at least 0.85; deterministic identity usually scores 0.98; USDA matches score at most 0.95 (limited fuzzy matches 0.9); OFF scores 0.95/0.8; validated nutrient LLM fallback scores 0.6; LLM weight estimates score 0.7. Final scores below 0.6 are withheld. Unmatched ingredients have zero source/final confidence. An LLM self-rating cannot prove an interpretation is correct, so explicit state and nutrition-changing qualifiers are also checked after parsing.

Raw/fresh equivalence is limited to edible vegetables, fruits and herbs. Dry/cooked/canned/drained/frozen remain separate; a missing profile is not replaced with another preparation state. Unqualified mature grains/legumes default to dry; unprepared fruits/vegetables/nuts can default to raw. Basmati uses the documented long-grain white-rice proxy and red onion the onion reference. “Frisch gerieben/gemahlen” describes recent preparation and does not turn a dry spice into a fresh ingredient.

## Ingredient preparation and serving interpretation

Input is Mealie's structured ingredient data, not a general recipe-text parser. Food name, note, original text (camelCase or legacy snake_case), display text and can/tin units provide state clues. Recipe instructions can establish soaking when linked to the ingredient by a reference ID or bean-specific text. Unrelated soaking instructions do not turn other ingredients into dry foods.

Explicit state takes precedence over inferred defaults:

- Dry, cooked, canned, drained, raw, frozen and fresh remain distinct.
- Mature pinto/kidney beans and white/basmati rice default to dry input weights when unspecified. Cooking instructions later in the recipe do not change the original measured mass to cooked-food nutrition.
- Generic “Bohnen” requires a relevant soaking clue to infer dry; it does not select a bean species automatically. Green beans are not treated as dry legumes.
- Unprepared vegetables default to raw; parsley and identified coriander leaves default to fresh.
- Bare “Koriander” remains ambiguous between leaves and seeds and has no bundled default profile.
- Contradictory dry/cooked/canned state is left unmatched with a reason.

`recipeServings`, when finite and positive, takes precedence over `recipeYield`. A conflict is logged. If structured servings are absent/invalid, positive numeric yield text is used, including German decimal commas and decimal range midpoints. Mass/volume yields such as “1 kg” are not used as serving counts. No valid servings means no per-serving nutrient fields are written. A loaf/jar yield can still be interpreted as item count; explicitly setting servings is preferable for those recipes.

Ingredient hashes include the nutrition version, configured pinch mass, notes, original text, unit standard conversions and recipe instructions. Changes to interpretation inputs therefore trigger re-estimation through existing hash-based processing.

## Weight conversions

German aliases, case, abbreviation periods, umlauts and transliterations are handled by the shared unit normalizer. TL/Teelöffel, EL/Esslöffel, Prise, Stück/Stk., Zehe/Zehen and metric units share the English conversion path.

Explicit Mealie standard mass conversions take priority. Explicit standard volume conversions still need the ingredient density. For recipe estimation, volume and piece units use ingredient/state-specific USDA household measures where available. Approximate examples:

| Measure | Edible mass |
| --- | ---: |
| 1 tbsp olive oil | 13.5 g |
| 1 tbsp flour | 7.8 g |
| 1 tsp salt | 6 g |
| 1 tsp cumin | 2.1 g |
| 1 tsp curry powder | 2 g |
| 1 tsp dried thyme leaves | 1 g |
| 1 garlic clove | 3 g |
| 1 medium onion | 110 g |
| 1 pinch | 0.25 g by default |

Spoons are modeled as 5/15 ml and cups as 240 ml. USDA household measures are approximate; spoon packing, heaping, grind, temperature and onion size are not known. For example, a tsp-derived oil density and a directly listed tablespoon can differ slightly. Water uses 1 g/ml. Unknown densities/piece weights use bounded LLM estimates if enabled; otherwise the ingredient is unmatched. Legacy direct `convertToGrams` calls without food context retain prior volume defaults, but recipe estimation always supplies context.

Can/jar package weights are not standardized. A supplied gram quantity is respected; an unspecified can size still needs LLM estimation or an explicit Mealie standard quantity. Drained mass is used as supplied, not guessed from an undrained package weight.

## Bundled generic data

The checked-in dataset contains 171 profiles extracted from the official [USDA FoodData Central SR Legacy CSV archive (2018)](https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_sr_legacy_food_csv_2018-04.zip). Each profile records its FDC ID, category, English synonyms, exact source description and household portions. [FoodData Central](https://fdc.nal.usda.gov/) is the source of the food composition data; this is a reproducible reference subset covering herbs, spices, vegetables, fruits, grains, legumes, dairy, oils, nuts/seeds and basic sauces, not a comprehensive database.

Examples of source IDs:

- Pinto beans: dry 175199; boiled unsalted 175200; canned including liquid 175201; drained 174286.
- Kidney beans: dry red 173744; boiled unsalted red 175194; canned including liquid 175195; drained 174285.
- White rice: dry 169756; cooked 169757. Generic basmati uses these long-grain white-rice proxies.
- Olive oil 171413; sunflower oil 171025; unsalted butter 173430; canned full-fat coconut milk 170173.
- Onion 170000 (also a documented proxy for red onion); garlic 169230.

USDA carbohydrate by difference includes fiber; the importer subtracts fiber to use the available-carbohydrate convention of the LLM prompt and typical European labels. Energy remains the source's measured/calculated kcal rather than being reconstructed from macros. Missing nutrients stay null. Sodium/cholesterol are already in USDA mg units and are not multiplied again.

To regenerate, download the archive above and run `python3 scripts/import-usda.py /path/to/archive.zip` from any directory. Python is only a maintenance tool, not a runtime dependency. Runtime code and data compile with the existing TypeScript build.

## Plausibility, caching and logging

Profiles reject negative/non-finite values, impossible mass/energy bounds, absurd sodium/cholesterol, fat fractions exceeding total fat, clearly inconsistent sugar/carbohydrate or macro mass, and gross energy/macronutrient disagreement. Energy checks use protein*4 + available carbohydrate*4 + fat*9, with fiber allowed separately at approximately 2 kcal/g; LLM fallback profiles use a tighter tolerance and receive one corrective retry when rejected. Fiber energy, food-specific Atwater factors, alcohol and rounding receive reasonable tolerance; this is error detection rather than laboratory validation. Salt's 39.3% sodium is intentionally permitted.

Recipe warnings flag more than 3000 kcal or 5000 mg sodium per serving, invalid inputs, partial estimates, serving conflicts and gross calorie/macronutrient disagreement. Warning-level values may be legitimate for a large batch or condiment, so they are not automatically discarded. Patch fields with clearly extreme/non-finite/negative values are omitted with a warning (hard ceilings: 10,000 kcal, 40,000 mg sodium, 10,000 mg cholesterol or 2,000 g of an individual macro per serving). Omitting a field does not erase an existing value in Mealie.

Caches include a version, source, canonical identity and state. OFF caches retain product name and confidence. LLM weight caches also include normalized units and state-bearing food queries; cached weights are revalidated against bounds. Old mixed-unit and name-only nutrient entries are bypassed. Maintainers must bump `NUTRITION_VERSION` after changing profile semantics or reference data. TTL cleanup remains available through the existing configuration; old bypassed entries age out. Recipe hashes also include this version, so a normal subsequent backfill/on-demand estimate can refresh estimator-managed recipes. No cache database, running service or live recipe is modified by developing this change.

With existing `LOG_LEVEL=debug`, ingredient logs show original name, normalized query, state/reason, quantity, unit, grams, source, selected product, qualitative confidence, kcal/100g, sodium mg/100g, contributions and fallback reasons. Candidate scores and validation rejection reasons are logged. Recipe logs include totals, per-serving kcal/sodium, servings and warnings. OFF calls time out after 15 seconds per attempt; LLM calls after 60 seconds.

## Configuration and remaining limits

Optional variable: `PINCH_GRAMS`, recommended default **0.25**. Values from 0.05 through 0.5 g are accepted; invalid/out-of-range values revert to 0.25. Setting 0.4 restores the earlier pinch default. Existing token, model, endpoint, rate-limit, cache and deployment configuration is unchanged. No new dependency is required.

Reference nutrient and density values are population averages. Brands, salting, rinsing, cooking loss, variety, edible portion, spoon packing and can sizes vary. Frozen or uncommon preparations without a profile fall back conservatively. No automatic dry-to-cooked mass expansion is applied; input quantity always means the measured state. Instruction inference is limited to explicit, attributable clues and cannot resolve every recipe narrative.

OFF can use differing carbohydrate conventions or incompletely identify a liquid's nutrition basis; only an explicitly identified per-100ml basis can be normalized confidently. LLM unit compliance is requested and bounded, but cannot be proven by a plausible number alone. Missing individual nutrient fields can still make that nutrient total incomplete; per-ingredient nulls expose this, but the service does not model uncertainty intervals. Missing entire ingredient quantities, weights or profiles are governed by the partial-estimate policy below. No live self-hosted Mealie deployment was available for end-to-end UI verification; tests assert API patch fields and use verified upstream unit labels.


## Partial-estimate write safety

`PARTIAL_ESTIMATE_POLICY` has two supported values:

- **`withhold` (default):** if any ingredient has an invalid/missing quantity, unknown weight, ambiguous state or unavailable nutrient profile, do not write any nutrition fields to Mealie. No negligible-mass exception is assumed, since small masses can still contribute meaningful sodium or other nutrients.
- **`fill-empty` (explicit opt-in):** a partial result may be written only when **all** existing nutrition fields are null, empty or whitespace. Any existing value, including zero or a lone sodium value, protects the entire nutrition object. Unknown existing nutrition is treated as protected. This mode can show incomplete nutrition and should be enabled only when that is intentional.

Both modes preserve existing nutrition whenever any value is present. Partial attempts never update calorie/digestibility tags, and a withheld patch omits the `nutrition` and `tags` keys entirely. Existing unrelated extras and previous complete total/yield metadata are retained. Empty section headings do not count as ingredients; unparsed ingredient text and unknown quantities do.

Extras expose the attempted estimate independently of retained nutrition:

- `calorie_estimator_partial`: `"true"` or `"false"`, describing ingredient coverage in the latest attempt.
- `calorie_estimator_partial_policy`: the active policy.
- `calorie_estimator_nutrition_status`: `"partial-withheld"`, `"partial-written"`, or `"complete"`. The existing no-servings warning still applies to complete ingredient coverage without a usable serving count.
- `calorie_estimator_unmatched` and `calorie_estimator_unmatched_details`: missing ingredient names and known gram weights/reasons.
- `calorie_estimator_partial_total_kcal`: the known subtotal for diagnostics only; it is not written under the complete-total key.
- `calorie_estimator_attempt_hash`: records the attempted inputs. Partial attempts set the completed `calorie_estimator_hash` to an empty string so a later backfill can retry. Policy changes also change recipe hashes.

When the missing ingredient resolves, a complete attempt writes nutrition normally and clears the partial flag, stale warnings and partial subtotal. A previously correct Mealie value is never replaced by a known partial estimate. The flag measures ingredient coverage; it does not assert that every micronutrient within a matched profile is known.


## Partial webhook idempotency

Webhooks skip `partial-withheld` and `partial-written` attempts when `calorie_estimator_attempt_hash` equals the current input hash. The skip occurs before nutrition lookup, LLM calls, tagging or patching, so an extras-only patch cannot trigger another estimate for the same input. The completed hash remains empty: explicit `/estimate` and `/backfill` requests can still retry partial attempts under the existing eligibility/manual-value rules. Input changes also permit retries. Cache expiry alone does not retry unchanged webhook input.

The input hash uses fixed-order projections of quantities, food names, unit conversion fields, notes/original text/display/title, instruction text and ingredient-to-instruction links, servings and yield. It includes the nutrition/estimator semantics versions, pinch/partial policy, OFF language/source and LLM enablement/model/source. It excludes secrets, nutrition, extras, tags, timestamps, API IDs and unrelated metadata. Instruction links are represented by linked text rather than unstable IDs. Ingredient order and JSON object property order do not affect the hash. The former hash serialized entire unit/instruction objects, so metadata or property-order changes could alter it even when the recipe looked unchanged; byte-identical input and identical configuration were already deterministic.

This release changes the hash format and nutrition version (`nutrition-v7-semantic`), so old attempts are reconsidered once on the next eligible event. Future changes to nutrient data or estimator semantics must bump the corresponding version. Instances processing the same recipes must run the same estimator version/configuration.

Plain `water`/`Wasser` uses a deterministic zero-calorie, zero-macro profile and zero sodium default, with density 1 g/ml. Actual sodium depends on the water supply; this default is not a mineral analysis and does not apply to branded/mineral/flavoured products. Unitless Garam Masala remains unknown weight: spice-blend composition and spoon packing vary, and no teaspoon or piece weight is invented. An explicit unit allows the existing validated conversion/fallback path.


## Semantic interpretation, caching and evaluation

No new environment variables or dependencies are required. Existing `LLM_ENABLED=true`, provider URL/model and API key enable both classification and the existing fallbacks. With the default `LLM_ENABLED=false`, deterministic generic names and existing aliases still work, but arbitrary German wording cannot be translated automatically. Credentials/configuration files are not changed by this implementation.

Interpretation has its own SQLite `ingredient_interpretation_cache` table, separate from OFF and LLM nutrient tables. Keys include interpretation/data versions, model/provider, normalized ingredient text, unit, state-relevant notes and linked instructions. Structured quantities and servings, output metadata and leading display amounts are excluded; percentages are preserved. Concurrent identical classifications share one request. Valid responses and explicit/validation failures are cached using the existing `OFF_CACHE_TTL`; network/server failures are not persisted. Existing LLM cache clearing also clears interpretations. Nutrient keys include source, identity, state, generic flag and brand. An explicit recipe retry still respects valid caches; clear LLM caches or change model/version when reevaluating a cached classification.

The selection manifest is `src/nutrition-data/selection.json`. `scripts/import-usda.py` regenerates every profile from the official SR Legacy archive, retaining source values and household measures; it does not use generated nutrient numbers. Add reference foods/states to this manifest when expanding composition coverage. German synonyms do not need to be added to the runtime for each new wording. Blends such as Garam Masala have variable composition and no dedicated SR Legacy reference here; classification preserves the blend, and an explicit unit/weight allows bounded weight and nutrient fallback rather than substituting curry powder.

`tests/fixtures/german-ingredients.json` contains 90 German examples. Automated tests use controlled provider responses to verify classification contracts, state/brand boundaries, generic source routing, confidence handling, caches and partial safety. They do not claim an empirical 90/90 score for a live language model. All 171 bundled profiles are checked against nutrient plausibility constraints. Tests retain the webhook-loop regression and existing unit/sodium/recipe cases.

Optional live classification evaluation with your existing configuration:

```sh
npx tsx scripts/evaluate-semantic.ts
```

This uses the configured provider and normal API usage, may reuse valid interpretation caches, reports mismatches, and exits unsuccessfully if any expected generic match is missing. It does not estimate nutrients or patch Mealie. It has not been run against a live provider during development.

Debug logs include canonical identity, interpretation source/category, generic/brand status, matched USDA description/FDC ID or OFF product, all confidence scores, grams, per-100g energy/sodium and absolute macro contributions. Unknown classifications/weights remain visible as unmatched with reasons. High confidence still does not guarantee exact composition: varieties, mixtures, brands, edible portions and water content vary.
