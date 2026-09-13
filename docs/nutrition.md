# Nutrition estimation: units, preparation and provenance

## Unit contract

Every `NutrientSet` / `NutrientProfilePer100g` describes **100 g edible food**:

- Energy: kcal.
- Protein, available carbohydrate, fats, fiber and sugar: grams.
- Sodium and cholesterol: **milligrams**.
- `null` means unknown, distinct from a measured zero.

`RecipeNutrientTotals` and `PerServingNutrition` use absolute quantities with explicit names (`kcal`, `proteinG`, `sodiumMg`, etc.). The estimator sums contributions as `profile × ingredient grams / 100`, then divides totals by servings once. No intermediate rounding is performed. Mealie output rounds kcal, sodium mg and cholesterol mg to integers, and macro grams to two decimals. JSON strings use plain numeric notation, not locale-formatted thousands separators.

The legacy `totalNutrients` and `perServingNutrients` fields remain available for API compatibility, but their `Per100g` suffixes are deprecated when they hold totals. Their sodium/cholesterol values now consistently mean mg. External consumers relying on the old, inconsistent units must update.

### Confirmed sodium/cholesterol bug

[OFF's normalized nutrient schema](https://openfoodfacts.github.io/documentation/docs/Product-Opener/schemas/schemas/product_nutrition/) defines weight-based `_100g` values in grams, including sodium and cholesterol. Contributor `_unit` fields must not be applied again to those normalized values. [Mealie's frontend unit labels](https://github.com/mealie-recipes/mealie/blob/mealie-next/frontend/app/composables/recipes/use-recipe-nutrition.ts) use milligrams for both API fields. The previous code copied OFF grams straight to those fields and allowed the LLM to choose unspecified units.

OFF values are now multiplied by 1000 exactly once, at ingestion. If sodium is missing but salt is supplied, sodium is calculated as OFF salt / 2.5, then converted to mg. Per-100ml OFF profiles are divided by a known ingredient density to establish a per-100g basis; explicitly per-100ml profiles without known density are rejected.

For example, OFF sodium `0.4` g/100 g becomes `400` mg/100 g. A 200 g ingredient contributes 800 mg total, or 400 mg each for two servings. It cannot become 400 g through this conversion. The same boundary applies to cholesterol.

The old mismatch is established from code. The exact reported 20,913 mg recipe value cannot be reconstructed without its original ingredients, matched products, cached values and LLM responses. Old OFF values alone were generally understated by 1000; arbitrary LLM units and bad food/weight matches could also cause severe overestimates. Do not interpret a German display of `20.913 mg` as a small decimal quantity.

## Source selection

1. Recognized plain table salt uses deterministic composition: 39,300 mg sodium per 100 g salt, zero kcal/macros. It bypasses OFF and LLM entirely.
2. A generic ingredient with an exact canonical identity/state profile uses the bundled USDA reference **before any OFF request or cache lookup**. This includes the documented basmati/long-grain-rice and red-onion/onion proxies. Organic labels and simple preparation terms can normalize to generic identities; brand names and unknown product qualifiers are not stripped to force a generic match.
3. Specific branded/packaged names, and ingredients without a canonical profile for the requested state, use OFF first. OFF searches up to ten candidates. Candidate identity, preparation state, profile plausibility and available generic reference checks must pass before selection. Exact state matches rank above compatible unqualified names. The highest-scoring trustworthy candidate wins.
4. If no reference profile exists and OFF fails, use LLM nutrition with explicit units, validation, and a JSON-null failure option. Ambiguous/conflicting state is not sent for speculative nutrition. A missing cooked/canned/drained profile is never filled using a dry profile.

Confidence labels are qualitative, not calibrated probabilities. Deterministic salt is separate from a high/medium OFF match, a medium generic reference/proxy and a low-confidence LLM fallback. A successful OFF match still cannot guarantee product composition; branded titles not recognized as the same food are conservatively rejected. There is no fuzzy substring acceptance of ready meals, sauces, or drinks as their component ingredients.

The same comparison distinguishes coconut milk from coconut drink, cream from cooking cream, coriander seeds from leaves, and dry rice from cooked rice. Simple chopping/grating does not create a different food identity. Nutrition-changing qualifiers such as light, salted and low-sodium in notes are preserved. Generic reference energy checks allow variation rather than requiring identical label numbers.

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

The checked-in dataset contains 31 profiles extracted from the official [USDA FoodData Central SR Legacy CSV archive (2018)](https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_sr_legacy_food_csv_2018-04.zip). Each profile records its FDC ID, exact source description and household portions. [FoodData Central](https://fdc.nal.usda.gov/) is the source of the food composition data; this is a deliberately small reference subset, not a comprehensive database.

Examples of source IDs:

- Pinto beans: dry 175199; boiled unsalted 175200; canned including liquid 175201; drained 174286.
- Kidney beans: dry red 173744; boiled unsalted red 175194; canned including liquid 175195; drained 174285.
- White rice: dry 169756; cooked 169757. Generic basmati uses these long-grain white-rice proxies.
- Olive oil 171413; sunflower oil 171025; unsalted butter 173430; canned full-fat coconut milk 170173.
- Onion 170000 (also a documented proxy for red onion); garlic 169230.

USDA carbohydrate by difference includes fiber; the importer subtracts fiber to use the available-carbohydrate convention of the LLM prompt and typical European labels. Energy remains the source's measured/calculated kcal rather than being reconstructed from macros. Missing nutrients stay null. Sodium/cholesterol are already in USDA mg units and are not multiplied again.

To regenerate, download the archive above and run `python3 scripts/import-usda.py /path/to/archive.zip` from any directory. Python is only a maintenance tool, not a runtime dependency. Runtime code and data compile with the existing TypeScript build.

## Plausibility, caching and logging

Profiles reject negative/non-finite values, impossible mass/energy bounds, absurd sodium/cholesterol, fat fractions exceeding total fat, clearly inconsistent sugar/carbohydrate or macro mass, and gross energy/macronutrient disagreement. Fiber energy, food-specific Atwater factors, alcohol and rounding receive broad tolerance; this is error detection rather than laboratory validation. Salt's 39.3% sodium is intentionally permitted.

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

This release changes the hash format and nutrition version (`nutrition-v6-water`), so old attempts are reconsidered once on the next eligible event. Future changes to nutrient data or estimator semantics must bump the corresponding version. Instances processing the same recipes must run the same estimator version/configuration.

Plain `water`/`Wasser` uses a deterministic zero-calorie, zero-macro profile and zero sodium default, with density 1 g/ml. Actual sodium depends on the water supply; this default is not a mineral analysis and does not apply to branded/mineral/flavoured products. Unitless Garam Masala remains unknown weight: spice-blend composition and spoon packing vary, and no teaspoon or piece weight is invented. An explicit unit allows the existing validated conversion/fallback path.
