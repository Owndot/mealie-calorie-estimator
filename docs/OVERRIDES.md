# User-confirmed overrides

Some ingredients cannot be resolved honestly by any amount of automation. Asked which of four
genuine light mayonnaises a recipe means, the correct machine answer is "I don't know" — they are
materially different products and nothing in the recipe distinguishes them.

An override is how a person settles that once.

## What an override is

A **pointer** to a real provider record — never a copy of its numbers.

- the nutrients are reloaded from the provider on every resolution
- `overrides.db` holds identity, target and audit metadata; it contains **no nutrient columns**
- a target that cannot be loaded produces *no* match, and the ingredient falls back to normal
  resolution with its honest flag intact — never a stale value wearing the override's name

## The key

```
ov1 | canonicalEnglish | state | form | preservation | fatPercent | brand?
```

It describes the **ingredient**, not the resolver and not the target. Deliberately absent:

- the **route** — an implementation detail an override must survive
- the **target's** provider and brand — binding "mager" to an Edeka product must not make "Edeka"
  part of what the ingredient *is*; the brand in the key is the ingredient's own, and only when the
  ingredient text actually named one
- `coreFoodEnglish` — a lossy projection of `canonicalEnglish`

Matching is **exact**, never fuzzy. These are five different keys and an override on one never
reaches the others:

```
Rinderhackfleisch            ov1|ground beef|raw|unknown|unknown|-|-
Rinderhackfleisch mager      ov1|lean ground beef|raw|unknown|unknown|-|-
Rinderhackfleisch 5 % Fett   ov1|lean ground beef|raw|unknown|unknown|5|-
Rinderhackfleisch 10 % Fett  ov1|lean ground beef|raw|unknown|unknown|10|-
gekochtes Rinderhackfleisch  ov1|cooked ground beef|cooked|unknown|unknown|-|-
```

Note the 5 % and 10 % variants classify to the same English identity — the stated percentage is the
only thing separating them, which is exactly why it is in the key.

Classifier drift makes a key **miss**, so the override stops applying and normal resolution runs. It
can never mis-apply to a different food. The management API reports `stale: true` for a row written
under an older key shape rather than silently re-targeting it.

## OFF-backed targets

A barcode target is re-checked on a schedule rather than on every resolution:

| condition | behaviour |
|---|---|
| cached < `OFF_PRODUCT_TTL` (24 h) | serve from cache, no request |
| older, refetch succeeds | refresh and serve |
| older, refetch fails **transiently** | serve the cached record within `OFF_PRODUCT_STALE_GRACE` (7 d) |
| OFF says **not found** | broken immediately, whatever the cache holds |
| beyond TTL + grace, still failing | broken → normal resolution |

The transient/authoritative split is the point: a rate-limit or a 5xx says nothing about the product
and must not silently change a recipe, while a deleted product must not be kept alive by a cached
copy.

## API

Requires `OVERRIDE_ADMIN_TOKEN` and `Authorization: Bearer <token>`. Unset means the routes are not
registered at all.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/overrides` | list, with live target status |
| `GET` | `/overrides/:id` | inspect one |
| `POST` | `/overrides/preview` | key + what it resolves to now and without the override |
| `PUT` | `/overrides` | create/replace — refuses a target it cannot load |
| `DELETE` | `/overrides/:id` | remove |
| `GET` | `/overrides/suggestions?slug=…` | ingredients in those recipes worth overriding |

Addressed by a short opaque `id`, not the semantic key — the key contains spaces and separators and
its shape may change.

## Provenance

```json
{"provider":"off","providerId":"4313249214975",
 "productName":"Mageres Rinderhackfleisch zum Braten",
 "matchReason":"user-confirmed-override","confidence":0.95}
```

The real provider and id stay visible: the override is the *reason*, not the source.

## Backups

`overrides.db` is the one file here that cannot be reconstructed. Back up `/app/data`.
