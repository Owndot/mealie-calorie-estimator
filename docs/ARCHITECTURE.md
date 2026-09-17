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
| 6 | `llm-nutrient` | nothing else could answer |

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
