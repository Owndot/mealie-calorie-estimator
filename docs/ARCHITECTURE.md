# Architecture

How an ingredient becomes a number, and why the order matters.

## Pipeline

```
Mealie webhook
  └─ fetch structured recipe          originalText is never read
  └─ classify ingredients             ONE batched LLM request per recipe, cached, temperature 0
  └─ resolve grams                    structured conversion → density → piece weight → LLM estimate
  └─ resolve nutrients                the provider chain below
  └─ calculate                        Σ (per-100 g × grams) ÷ servings, exactly once
  └─ PATCH nutrition + provenance     never ingredients, names, quantities or user content
```

## Provider chain

| # | Provider | Answers when |
|---|---|---|
| 1 | `mealie-recipe` | an ingredient is named exactly like one of your own recipes |
| 2 | `food-override` | you deliberately bound this ingredient |
| 3 | `bls` | a German identity matches BLS 4.0 |
| 4 | `usda-local` | a generic identity matches Foundation / SR Legacy |
| 5 | `off` | a branded product matches, or a verified proxy is justified |
| 6 | `llm-nutrient` | nothing else could answer, and `LLM_ENABLED` + API key + `LLM_NUTRIENT_ENABLED` allow generation |

Your own recipes come first because a homemade paste is the one food no public database can know.
Overrides come second — after your recipes, before anything automatic — because a recipe is *live*
user data that updates when you edit it, while an override is a static pointer; letting the pointer
shadow the recipe would make editing it silently ineffective.

## Hard gates

Before any scoring, a candidate is rejected outright if it is a *different food*. These are not
tie-breakers; a high text-similarity score can never rescue a gate failure.

- **food type** — a simple ingredient cannot accept a composite dish
- **core identity** — a candidate whose name contains none of the query's core tokens
- **specificity** — a candidate must not add a transformation the query never asked for (canned,
  cooked, flour), and must not pick a plant part the query left ambiguous (leaf vs seed)
- **carrier** — a product derived *from* something must name that something; pickle brine is not
  bottled water
- **form / preservation / fat %** — a stated attribute the candidate contradicts
- **brand** — on a generic route, an arbitrary manufacturer's product

A database miss is preferable to a confident wrong match.

## Attributes and provenance

Each ingredient carries what it *claims* (`form`, `preservation`, `fatPercent`, a modifier family
such as reduced-fat) and each record carries what it *states*. When a record satisfies the identity
but not the claim, it is used and the shortfall recorded in `unmetAttributes` — visible in
provenance and in match quality, never silently dropped.

Provenance per ingredient: provider, record id, product name, confidence, dataType, matchReason,
`unmetAttributes`, the classification used, and judge fields when the judge ran.

## Semantic judge

Off by default (`LLM_JUDGE_ENABLED`). Consulted **only** where the chain would otherwise produce a
generated value and real records survived every hard gate but scored too low to be used.

- it receives a deterministically ordered shortlist and must return an id **from that list**
- nutrients always come from the selected record; the model never supplies a number
- `ambiguous` / `none` / a timeout / an invalid reply all leave the existing outcome untouched

It therefore cannot make an accepted result worse. Replacing an already-accepted database record is
deliberately **not** implemented — benchmarking found no stable, justified case for it.

The estimator uses `resolveNutrientsWithDiagnostics`, whose unresolved result has `match: null`
and retains the existing judge metadata. The match-only `resolveNutrients` entry point retains
its `ResolvedNutrients | null` contract for existing callers. Both matched and unresolved
ingredients serialize the same judge fields. Invalid replies and request failures keep a null
verdict with the failure reason; rejected selections retain `selected` with a rejection reason
and do not acquire nutrients. Eligibility alone is still recorded when the judge does not run.

## Pipeline concurrency

`runEstimationPipeline` schedules the entire read/estimate/write operation through one process-local
queue. `ESTIMATION_CONCURRENCY` defaults to 2. Estimate, webhook and backfill entry points share it;
each retains its existing options and response behavior. The same slug runs serially, and the
oldest runnable job takes each available slot. Failures release both the slot and recipe lock.
No write retries or durable job delivery are introduced. Direct read-only resolver calls from the
override API are outside this pipeline limit.

## Open Food Facts as a verified proxy

OFF is branded retail data, not a generic database. It is queried when a *qualitative* claim needs a
label ("mager", "light") that composition databases do not carry, or when a stated number has no
local record. Hits pass a strict filter — usable energy, the core food present in the product
**name** (not the brand), category compatibility, measured fat matching a stated percentage — before
the judge ever sees them.

## Determinism

Classification runs at temperature 0 and is cached per ingredient, so a recipe re-estimated tomorrow
is read the same way it was today. An unqualified quantity refers to the state the ingredient is
*bought* in — "300 g Nudeln" is dry pasta even in a recipe that goes on to cook it — and a
transformation the text does not state is refused rather than guessed.

Candidate ordering for the judge is a pure function of the candidate set, and decisions are cached
by ingredient identity + the exact pool, so the same question yields the same answer.

See [CACHING.md](CACHING.md) for cache layers and TTLs, [OVERRIDES.md](OVERRIDES.md) for overrides.

## Recipe vocabulary

A sparse, curated map from what people write in recipes to what the databases call it, sitting
between normalization and the resolver:

```
ingredient -> normalization -> recipe vocabulary -> provider chain
```

`resources/recipe-vocabulary/{de,en}.json`, loaded and validated once, exact normalized alias
matching only. It is an enrichment layer, not a provider: it supplies the canonical identity that
deterministic mode cannot derive for itself, and everything it does not know falls through to the
existing resolver untouched.

Five kinds, and the distinction matters for provenance: `synonym` is a fact about naming,
`recipe_default` is an assumption the project makes on the cook's behalf, `exact_phrase` carries
attributes the phrase states, `spelling_variant` is a misspelling someone actually wrote, and
`ambiguous` records that no safe default exists and blocks the resolver from narrowing.

A `preferred` target names a provider and record id — never copied nutrients. It is re-loaded live,
sanity-checked, and checked using existing state, form, preservation, measured fat and food-type
conflict rules. A reviewed pointer supplies the identity link; it is not re-derived from the classifier's
free-text core. Stated modifier families and explicit identity conflicts must still pass. Failure drops the
preference and normal resolution continues. Recipes and user overrides retain priority, as does
OFF on the branded route.

A genuine classifier result (`llmClassified`, or an existing core in either language) suppresses
vocabulary enrichment of identity, attributes and state. Reviewed preferred targets and ambiguity
assertions remain active. A classifier that renames the food can invalidate a preference, while
a curated ambiguity guard still stands. Explicit form and preservation words in the original
ingredient remain authoritative over classifier attributes. Cheese fat in dry matter is a grade,
not grams of fat per 100 g; conflicting named grades are rejected separately.

Vocabulary attributes accept only `state` (`raw`, `cooked`, `dried`, `unknown`), `form` and
`preservation` from the existing runtime enums, and finite `fatPercent` in [0, 100] or null.
Unknown keys and invalid values reject the row. Every alias duplicated across languages is
removed from both languages, even if the entries are identical; lookup never arbitrates by file
order. Rejection is logged. No language detection is used.

`classification.vocabulary` is null/absent when no row matched. Its presence (`alias`, `kind`)
means only that the alias matched. `semanticsApplied` means vocabulary fields enriched a query
that was actually resolved, or its ambiguity restriction was in force; it does not assert that a
record was found. It is false if grams prevented resolution, a classifier supplied the semantics,
or a higher-priority recipe/override/branded OFF source supplied the result. `preferredSelected`
is true only when the resolver's preferred-target branch selected the record, never merely when
the resulting id happens to equal the preference. These decisions come from the actual query and
resolver; the estimator does not perform another lookup.

Compatibility is limited by available metadata: unknown record state/form/preservation and missing
measured fat remain permissive under the existing rules, not proof of compatibility. USDA has no
German core metadata, so a German-only curated translation to USDA cannot be independently checked
by the core gate. The reviewed link supplies that translation. Generic compound-head limitations
(#56) are unchanged, and plant-part ambiguity requiring a full candidate pool is not evaluated by
this single-record check.

The 84-row attribute audit removed unsupported `fat` (Fettarmer Joghurt), `packedIn` (getrocknete
Tomaten in Öl), `type` (Mehl Type 405), `colour` (rote Paprika and Spitzpaprika rot), `carbonated`
(Sprudel) and `style` (trockener Weißwein). Those distinctions are represented only by reviewed
targets and any existing name-based checks, not invented semantic axes. `state: roasted` for
gerösteter Sesam became `cooked`, the runtime's existing preparation class for roasting; the
preferred Sesam record itself has unknown state, so it does not independently verify roasting.
Crème fraîche's canonical identity uses the target's spelling `Creme fraiche`, keeping ordinary
retrieval compatible without changing accent normalization or adding another alias.

Sized by measurement. The original 84 entries were terms a 22-recipe corpus showed resolving wrongly or
not at all. The production audit adds 12 reviewed aliases; see [INGREDIENT-RESOLUTION-AUDIT.md](INGREDIENT-RESOLUTION-AUDIT.md). An independent 117-recipe corpus matched only 10% of its ingredient occurrences against
these aliases, so this is a mechanism to extend one measured failure at a time, not a vocabulary
project.

Ordinary OFF search retains the product barcode as its provider ID and checks measured fat. An
exact full branded ingredient name may identify a label that omits its translated generic core
(e.g. a cheese label without the word "cheese"). This requires an explicit brand in the ingredient,
keeps state/form/type/fat gates, and does not permit a different product variant or arbitrary brand
to substitute for a generic ingredient. The full structured name participates in its cache key.
