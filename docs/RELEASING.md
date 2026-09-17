# Releasing

One authoritative version: **the git tag**.

A maintainer states the version; nothing infers it. The release workflow builds that exact commit,
publishes the container image under the same version, and creates the matching GitHub Release —
tag, image tag and Release title are all derived from one input and cannot disagree.

## Why not semantic-release

The inherited pipeline ran semantic-release in CircleCI and pushed to a Docker Hub account this
project does not own. Beyond being unusable here, semantic-release would be actively wrong on this
repository: it derives the next version from the commits since the last tag, this repository has
**no tags**, and its history begins inside an upstream project already at 1.9.x. Pointed at that
history it would invent a version describing someone else's releases.

A stated version also suits the project: releases are deliberate, infrequent, and worth a human
deciding whether a change is a patch or a minor.

## Procedure

1. Make sure `main` is green and the working tree is clean.
2. Rehearse — build and verify **without publishing**:
   ```bash
   gh workflow run Release --ref main -f dry_run=true
   gh run watch
   ```
3. Set the version in `package.json` and merge that change through a normal PR:
   ```jsonc
   { "version": "1.1.0" }
   ```
   The workflow refuses to publish a tag that disagrees with `package.json`, so a release is always
   reproducible from the source tree.
4. Tag the merge commit and push:
   ```bash
   git checkout main && git pull --ff-only
   git tag v1.1.0
   git push origin v1.1.0
   ```
5. The workflow publishes `ghcr.io/owndot/mealie-nutrition-engine:1.1.0`, `:1.1`, `:latest` and
   opens the GitHub Release with generated notes.

## Versioning

Ordinary [semantic versioning](https://semver.org), judged against the **public** surface: the HTTP
API, environment variables, the override database, and nutrition results.

- **patch** — fixes that do not change a resolution
- **minor** — new capability, new configuration, or resolutions that change because matching
  genuinely improved
- **major** — a breaking change to the API, to configuration, or to stored data

A change in someone's recipe totals is a user-visible change even when the code change looks
internal. Say so in the release notes.
