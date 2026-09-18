# Ingredient resolution audit — 2026-09-18

Implemented against the local v1.3.0 checkout. The supplied production audit is the symptom list;
it is not a dump of the production classifier replies, cache, recipe payloads or logs. Therefore
reproduced mechanisms below are distinguished from conclusions that require production access.
No production recipes, overrides or deployment settings were changed.

## Evidence and method

- Read architecture, provider registration, normalization, vocabulary validation/application,
  BLS/USDA retrieval, scoring, reranking, judge pools, OFF and recipe/provenance paths.
- Queried the actual bundled SQLite databases, rather than a remote USDA search window. USDA has
  8,262 Foundation/SR Legacy records. No database or nutrient values were edited.
- Traced all 20 distinct unresolved names and both suspicious matches. Deterministic probes used
  real databases, no Mealie recipes/overrides and no network. Regression tests pass structured
  Mealie ingredients through normalization, query construction, real database selection and
  provenance, with both AI off and controlled classifier responses. Quantities are 100 g to
  isolate resolution from gram conversion.
- Consulted the existing local benchmark classifications as additional evidence, not as proof of
  what the separate production audit's classifier returned.
- Read-only live OFF searches and a live call through the updated OFF provider confirmed the
  Leerdammer case and conservative generic-product behavior. No live LLM calls were required.

## Root causes and decisions

1. **A vocabulary hit is not necessarily a target.** `Thymian` is deliberately `ambiguous`;
   `Reisessig` had no preferred record and enriched identity to overly broad `Essig`. Neither
   bundled database contains rice vinegar. Preserve rice identity and leave the miss visible.
   Bare coriander also stays ambiguous. No general relaxation of ambiguity guards is warranted.
2. **Missing reviewed identity links.** Fresh coriander, explicit paprika grades, curry spice
   blend and dried chili have suitable real records. Exact normalized aliases now supply reviewed
   pointers. Existing seed-coriander, curry powder, paprika powder, basmati and vegetable mappings
   remain pinned to their previous records.
3. **Classifier attributes could erase original wording.** Valid model output `unknown` or a
   contradicting form/preservation previously displaced deterministic textual evidence. Reconcile
   those attributes with the structured ingredient name, both during normalization and when
   constructing the resolver query. This does not infer nutrients or choose a plant part for bare
   coriander. Classifier free-text identities remain subject to existing precedence rules.
4. **Fat in dry matter was conflated with absolute fat.** A classifier returning 48 for Gouda
   rejects the exact BLS record's measured 31.58 g fat/100 g. Recognize the dry-matter notation,
   clear that erroneous absolute-fat claim, and retain separately stated absolute percentages.
   Compare explicitly named dry-matter grades separately; do not turn 48% into invented nutrients.
5. **Shared heads are insufficient identity.** `chili peppers` can satisfy the existing core gate
   through `peppers`, allowing sweet freeze-dried pepper. Add an explicit chili/sweet-pepper
   incompatibility before scoring and in cached-match validation. It excludes that candidate from
   reranker/judge pools. Also stop the existing pepper-spice rule from rejecting singular
   `chili pepper` as though it meant black pepper.
6. **An unqualified dairy default was implicit.** Deterministic cottage cheese selected the
   low-fat record by ranking. Make regular cottage cheese an explicit `recipe_default`, consistent
   with the existing practice for milk and Gouda. Explicit low-fat qualifiers are not aliases for
   this default, and conflicting measured fat rejects the preferred record.
7. **Food-type and score gates explain prepared components.** BLS liquid vegetable broth is
   `composite_dish`; the benchmark classifier called it `processed_single_food`, so the type gate
   rejects it. USDA hoisin has the same type issue. Even with the correct type, hoisin scored -8
   because `ready-to-serve` counted as two unexplained ingredients. Remove only that phrase from
   the score penalty; leave its original name and every hard gate intact. Correctly classified
   broth and hoisin now resolve in the regression tests. Incorrect food types remain a visible
   miss; no global type-gate exception was added.
8. **OFF product names need not repeat their English food category.** An exact `Leerdammer Leger`
   label was rejected by the inferred English core `cheese`. On an explicitly branded route,
   exact normalized equality to the complete structured name now supplies the identity evidence.
   State, form, preservation, type and measured-fat checks still apply. Different variants receive
   no exception. Cache keys include the structured name. Generic queries still reject arbitrary
   brands; the existing strictly filtered judge proxy remains separate.
9. **OFF provenance and fat validation were incomplete.** Ordinary search requested no barcode
   and wrote the product name as `providerId`; it also omitted the measured-fat callback used by
   ranking. Request/preserve `code`, report null when absent, and pass measured fat into the gate.
   Curated USDA matches now retain their `dataType` in provenance too.
10. **Compose omitted the nutrient switch.** The shared service environment now passes through
    `LLM_NUTRIENT_ENABLED`. Its default remains compatible with the existing application default;
    explicitly setting `false` now reaches Compose containers. Production must retain that setting.
    No generated nutrient source was enabled or used by this investigation.

Provider matching versions and the classification prompt version were advanced so previous
positive/negative cache entries cannot mask the changed matching behavior. Ingredient hashes do
not change merely because the resolver improves: existing recipe provenance needs a deliberate
re-estimation to reflect this release.

## Exact curated mappings

All pointers below reload their database records and pass the existing compatibility checks.
No nutrient values are copied into the vocabulary.

| Alias(es) added | Kind | Verified target | Reason |
|---|---|---|---|
| Koriander frisch; frischer Koriander | exact_phrase | USDA 169997 — Coriander (cilantro) leaves, raw | Explicit fresh herb; leaf/fresh attributes |
| Curry Gewürzmischung | recipe_default | USDA 170924 — Spices, curry powder | Generic dry curry blend; not Garam Masala |
| Paprika rosenscharf; Paprika edelsüß; Paprikapulver rosenscharf | exact_phrase | USDA 171329 — Spices, paprika | Explicit spice grades/powder, not vegetables |
| rote Chilischoten getrocknet; getrocknete Chilischoten | recipe_default | USDA 168570 — Peppers, hot chile, sun-dried | Generic dried hot chili; no invented cultivar-specific record |
| Gouda 48 % Fett i. Tr. | exact_phrase | BLS M402600 — Gouda 48 % Fett i. Tr. | Exact cheese grade; 48% is not absolute fat |
| körniger Frischkäse | recipe_default | BLS M711300 — Körniger Frischkäse mind. 20 % Fett i. Tr. | Explicit regular cottage-cheese default, 4.3 g measured fat/100 g |
| Thymian frisch | exact_phrase | USDA 173470 — Thyme, fresh | Fresh wording disambiguates the existing bare ambiguous alias |
| Gemüsebrühwürfel | synonym | BLS R821000 — Gemüse Bouillon/Brühe/Suppe (Brühwürfel, Pulver) | Dry vegetable bouillon, not diluted broth |

`Reisessig` changes identity from `Essig` to `Reisessig`, with no preferred record.
The resource now validates all 96 entries (86 German, 10 English).

Unchanged controls: coriander ground/seeds → USDA 170922; curry powder → USDA 170924;
sweet paprika powder → USDA 171329; red/pointed red bell pepper → BLS G543100;
basmati → BLS C352000; dried thyme → USDA 170938. Bare coriander and thyme remain ambiguous.

## Disposition of every unresolved name

| Ingredient | Finding / resulting behavior |
|---|---|
| Koriander frisch | Verified fresh-leaf mapping added; resolves in both tested modes |
| Koriander | Intentionally unresolved without a stated plant part; no fresh-leaf default |
| Garam Masala | No suitable generic blend record; not curry powder or the unrelated masala soup |
| Utskho Suneli | No matching record; the ordinary fenugreek-seed record does not establish this ingredient's identity |
| italienische Gewürzmischung | No verified generic Italian blend record; do not substitute a single herb |
| Gemüsebrühe | BLS X416243 is liquid broth; the recorded single-food classification blocks it. Correct composite classification resolves. Powder/cubes and liquid are not interchangeable |
| Gouda 48 % Fett i. Tr. | Exact BLS mapping plus corrected fat interpretation |
| Gemüsebrühwürfel | Verified dry vegetable-bouillon mapping; its weight still needs a structured unit or gram estimate |
| rosa Pfefferkörner | No verified pink-peppercorn record; do not substitute black pepper |
| körniger Frischkäse | Reviewed regular cottage-cheese default; explicit low-fat requests remain separate |
| Erythrit | No bundled erythritol record; do not invent even a zero-energy nutrient profile |
| Proteinpulver | Product composition varies; needs an identified product/override, not arbitrary OFF brand data |
| Gewürzpaste für Gemüsebrühe | Needs its exact homemade recipe or identified product; cannot substitute diluted broth or bouillon powder |
| Curry Gewürzmischung | Reviewed generic curry-powder default |
| Hoisin-Sauce | USDA 172886 is a real generic ready-to-serve sauce; correct composite classification now resolves after the score fix. Product-specific requests still need their product evidence |
| Reisessig | No bundled rice-vinegar record; retains rice identity and can stay unresolved |
| Leerdammer Leger | Live updated provider selected OFF barcode 4388860276916, exact label, 262 kcal/100 g, with explicit Leerdammer brand evidence; no barcode is hardcoded in production |
| Thymian | Existing ambiguity between fresh and dried retained; explicit fresh and dried forms resolve |

The two additional suspicious successes are covered directly: paprika rosenscharf selects the
spice record, and dried chili cannot select USDA 169373 (sweet, red, freeze-dried).

Live OFF searches returned several hoisin labels at 188, 228 and 291 kcal/100 g; rice-vinegar
labels included 27 and 145 kcal/100 g. These results are evidence against arbitrary product
substitution, not approved mappings. Both generic searches remained unresolved through the
ordinary OFF provider. Public product records can change after this audit.

## Recipes without provenance

`huhnchen-in-cremiger-tomaten-sahnesauce` and `knoblauch-hahnchen-reis-bowl` were not found in
available local recipe exports. No live Mealie connection or logs were supplied. Their individual
causes therefore remain **unverified**; this is not evidence of a vocabulary failure.

The checked pipeline has several distinct relevant paths:

- Nutrition already present without estimator provenance is treated as manually owned, including
  legacy manual acknowledgements that already have an ingredient hash. The manual acknowledgement
  deliberately writes no estimator provenance and does not overwrite nutrition.
- An unchanged ingredient hash can return `no-op` or update tags only; neither estimates again.
- Missing opt-in tags skips estimation. A fetch, estimation or PATCH failure may also prevent a
  completed provenance write; logs distinguish these failures.
- Every completed `buildNutritionPatch` includes provenance, even when ingredients are unresolved
  or totals are withheld. Missing ingredient mappings alone do not explain absent provenance.

Inspect each recipe's tags, nutrition and `calorie_estimator_*` extras alongside the pipeline
outcome/logs. Do not bypass manual-nutrition protection just to manufacture provenance.

## Validation and changed files

- Baseline: 1,117 passed; one existing test failed because it created a temporary SQLite fixture
  outside the permitted workspace. That test now uses the OS temporary directory.
- Final: `npm run typecheck`, full `npm test`, and `npm run build` pass. **62 test files / 1,203 tests passed** in the final complete run (31.59 seconds).
- `tests/real-world-ingredients.test.ts`: 77 cases, covering both normalization modes, all requested
  ingredient controls, intentional misses, actual record nutrients/IDs, provenance/dataType,
  dry-matter grades, explicit attributes, and exclusion of sweet peppers from judge candidate pools.
  AI-assisted cases assert zero direct nutrient-generation calls with the switch disabled.
- `tests/providers/off-provider.test.ts`: nine additional cases for barcode provenance, absent
  barcodes, measured-fat rejection, conservative generic brands, exact branded names, cache reuse
  and variant rejection.
- Existing LLM nutrient-switch, provider-routing, pipeline, manual-protection, recipe arithmetic,
  cache-safety and production-recipe integration suites run as part of the full suite.
- Compiled runtime smoke: USDA opens with 8,262 records; fresh coriander, paprika spice, dried chili,
  Gouda, cottage cheese and bouillon cubes resolve offline to the intended IDs.
- Compiled HTTP service smoke: `/health` returns `status: ok`; the temporary service was stopped.
- Live OFF provider check: exact Leerdammer resolves, generic hoisin/rice vinegar decline arbitrary
  branded results. No production mutation occurred.
- Docker image build, image-resource smoke and Compose/real-Mealie integration could not run:
  Docker is not installed in this environment. The repository CI Docker smoke should still run
  before release. Local compiled smoke is not claimed as a substitute for image validation.

Runtime changes: `src/services/resolver-query.ts`, `src/services/llm-normalizer.ts`,
`src/services/nutrient-resolver.ts`, `src/services/providers/{food-semantics,ranking,off-provider,
bls-provider,usda-local-provider}.ts`, `src/types.ts`, `resources/recipe-vocabulary/de.json`,
`docker-compose.yml`.

Tests: `tests/real-world-ingredients.test.ts`, `tests/providers/off-provider.test.ts`,
`tests/recipe-vocabulary.test.ts`, `tests/providers/usda-local-provider.test.ts`,
`tests/providers/evidence-cache-safety.test.ts`, `tests/helpers/production-fixtures.ts`.
The recorded chili fixture no longer needs its reranker-confidence exception: it now reproduces
production's correct hot-chili record deterministically at confidence 0.7.
Documentation: this report and `docs/ARCHITECTURE.md`.

## Remaining production validation

Re-estimate the real audited recipes with `LLM_NUTRIENT_ENABLED=false`, checking ingredient grams,
classifier food types, IDs and provenance before comparing recipe totals. The
`recipe_default` mappings (curry blend, regular cottage cheese and generic dried hot chili) are explicit
approximations within real composition records, not product-specific analyses. Test actual
classifications that contradict a preferred record's state/type and confirm those remain misses.
OFF exact labels require a recognized explicit brand and matching label text; spelling variants,
unlabelled products and API failures can still remain unresolved. Manual-owned recipes require
a separate intentional decision before their existing nutrition is overwritten.

---

# Follow-up — OFF as a last resort, 2026-09-18 (v1.3.1 production audit)

The v1.3.1 deployment moved real-world resolution from 89.8 % to 93.4 % (226 ingredient rows,
15 unresolved). This follow-up addresses what the deployed run then exposed, which was not what
the previous round predicted.

## What the production audit actually showed

Every curated mapping from the previous round resolves correctly **in deterministic mode**,
verified against the real bundled databases: dried hot chili → USDA 168570, fresh coriander →
169997, paprika spice → 171329, curry blend → 170924, Gouda grade → BLS M402600, cottage cheese →
M711300, bouillon → R821000. The failures are therefore not missing mappings.

## Root causes

1. **A reworded ingredient dropped its curated pointer.** `Koriander frisch` resolved in three
   recipes and not in a fourth. Reproduced: the batch classifier returns a different
   `canonicalGerman` per recipe, and for one batch it returned `Koriandergrün` — its own word for
   the same leaf. The rename gate treated any name unaccounted for by the alias or identity as a
   different food, so the pointer was discarded. Whole-recipe classification makes this a general
   hazard, not a coriander one. A rename is now only a contradiction when the two words share a
   HEAD and state different specifiers (`Gerstenmehl` vs `Weizenmehl`); sharing leading material
   (`Koriandergrün`/`Korianderblätter`) is agreement.

2. **OFF was never asked about branded or specialty foods.** The judge's OFF route was justified
   only for an unresolved *property* claim ("mager", "7 %"). An ingredient with no property claim
   and no local record answered `propertyKind: "none"` and stopped — so `Leerdammer Leger`,
   `Hoisin-Sauce`, `Reisessig`, `Proteinpulver`, `Garam Masala` and `Utskho Suneli` never reached
   the one source that stocks them. OFF is now justified on a second, independent ground: nothing
   answered at all.

3. **Identity came from the wrong text.** The OFF filter required the *English core* in the
   product name. `Leerdammer Leger`'s inferred core is `cheese`, which a cheese label has no
   reason to print. The last-resort filter takes identity from the structured name instead.

4. **Two ingredients never reached a provider.** `1 Stück Gemüsebrühwürfel` and
   `2 Scheiben Leerdammer Leger` converted to **no grams**, so the estimator dropped them before
   resolution and reported them exactly like a failed match — the bouillon cube's curated BLS
   mapping could never be used. `Scheibe` and `Würfel` were not routed to the piece-weight table
   at all, which also made the long-standing yeast `Würfel` weight unreachable.

## The last-resort OFF route

```
mealie-recipe → override → BLS → USDA → OFF (strict, branded/generic rules unchanged)
                                        → [nothing resolved]
                                           → broad OFF retrieval on the structured name
                                           → deterministic filter
                                           → LLM judge selects a REAL candidate, or NO_SAFE_MATCH
                                           → unresolved
```

Justified only when no real record resolved **and** no local record already states a requested
number. It deliberately does not require an empty local pool: a `Leerdammer Leger` query retrieves
plenty of generic cheese, none of which is Leerdammer.

What the filter stops caring about: brand, manufacturer, packaging size, capitalization,
punctuation, language, and the broad `en:plant-based-foods-and-beverages` category that the
property proxy excludes.

What it still enforces: the product must report energy; the ingredient's **most distinctive word**
must appear on the label (which is what keeps `Hoisin-Sauce` away from a plain soy sauce on the
shared word `sauce`); never-an-ingredient categories are barred; a stated fat percentage must
match within tolerance.

Acceptance is the judge's, never the filter's. The model receives real candidates and returns an
**id** — every nutrient is the chosen record's own, the barcode is the `providerId`, and
`NO_SAFE_MATCH` leaves the ingredient unresolved. With no judge available the route is not taken,
because it has no deterministic acceptance of its own. All of this holds with
`LLM_NUTRIENT_ENABLED=false`; selecting a real record and inventing one are different
capabilities, which is why they are different flags.

## Disposition of the 15 production misses

| Ingredient | Category | Expected after this change |
|---|---|---|
| `Koriander frisch` (tikka-paste) | F — rename dropped the pointer | Resolves to USDA 169997, consistently across recipes |
| `Gemüsebrühwürfel`-class cube weights | F — no gram conversion | `Stück`/`Würfel` now 10 g; the curated BLS R821000 becomes reachable |
| `Leerdammer Leger` | C/F — OFF never asked **and** no slice weight | `Scheibe` now 20 g; OFF last resort offers the real barcode 4388860276916 |
| `Hoisin-Sauce` | C/D — OFF never asked | Judge selects a real hoisin product, or declines |
| `Reisessig` | C/D | Rice-vinegar products exist in OFF; judge decides |
| `Proteinpulver` | C/D, with reservations | Composition varies widely between products; the judge may well decline, and that is correct |
| `Garam Masala` | C/D | Real blends exist in OFF; no generic record to fabricate |
| `Utskho Suneli` | C/D or E | Specialty blend; likely remains unresolved |
| `italienische Gewürzmischung` | C/D or E | Generic blend; judge may decline |
| `Erythrit` | C/D | Real products exist; no bundled record |
| `Koriander` (bare, ×2) | **E — intentionally unresolved** | Leaf (23 kcal) vs seed (298 kcal) is a 13× difference the wording does not settle |
| `rosa Pfefferkörner` | E, possibly C | No verified pink-peppercorn record; black pepper is not a substitute |
| `Gemüsebrühe` | E/F — classification-dependent | Liquid broth is `composite_dish` in BLS; resolves when classified correctly |
| `Gewürzpaste für Gemüsebrühe` | E | A homemade paste; needs its own recipe or an override |

Categories: **C** resolvable through OFF, **D** through retrieval + judge, **E** legitimately
unresolved, **F** a control-flow or conversion bug.

`Koriander` staying unresolved is the design working. Nothing in the wording says leaf or seed,
and guessing would be a 13× error.

## Status of the two reported anomalies

- **`rote Chilischoten getrocknet` → USDA 169373 (sweet, freeze-dried).** Not reproducible on
  current `main`. Probed deterministically and with five plausible classifier shapes, including
  ones that drop the word "chili" from the English name: every path returns USDA 168570 through
  the curated pointer. The pool exclusion of 169373 is asserted by an existing test. The
  production row is therefore attributed to provenance written before v1.3.1 reached the running
  container, or to an ingredient whose stored name differs from the audit's display string —
  **unverified without production access**, and no code path on `main` produces it.
- **`Koriander frisch` inconsistent across recipes.** Reproduced and fixed; see root cause 1.

## `knoblauch-hahnchen-reis-bowl`

Still not present in any supplied export, so its individual cause remains **unverified**. The one
recipe that was supplied, `huhnchen-in-cremiger-tomaten-sahnesauce`, is a worked example of the
most likely mechanism: it carries `calorie_estimator_manual: "true"` with the note
`Manual — preserved existing calorie entry`, and manual-owned nutrition deliberately writes no
estimator provenance. Check that recipe's `calorie_estimator_*` extras and tags before assuming a
resolution failure, and do not overwrite genuinely manual nutrition to manufacture provenance.

## Validation

`npm run typecheck`, `npm run build` and the full suite pass: **63 files / 1,229 tests**
(1,203 before). Docker could not be run in this environment; repository CI covers the image build
and smoke test.
