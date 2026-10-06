# Contributing to Better Newsletter

Thank you for your interest in contributing to Better Newsletter! This document provides guidelines and commands for local development, testing, and package releases.

## Prerequisites

- **Node.js**: `>=20.11` (Node.js 22.19+ recommended for Nuxt 4 examples)
- **Package Manager**: [pnpm](https://pnpm.io/) (`>=10.17`)

Clone the repository and install dependencies:

```bash
git clone https://github.com/t4sj4n/better-newsletter.git
cd better-newsletter
pnpm install --frozen-lockfile
```

---

## Workspace Structure

This repository is organized as a pnpm monorepo:

- [`packages/better-newsletter`](packages/better-newsletter/): Core runtime library, storage adapters (Memory, PostgreSQL), mailers (Resend), security primitives, and Nuxt integration module.
- [`packages/cli`](packages/cli/): `@better-newsletter/cli` executable for database schema migrations.
- [`playground/`](playground/): Local maintainer playground app with interactive controls (clock manipulation, failure injection, PostgreSQL/Resend modes).
- [`examples/basic/`](examples/basic/): Minimal copyable Nuxt 4 consumer demonstrating the Double Opt-In lifecycle, also used for the [StackBlitz demo](https://stackblitz.com/github/t4sj4n/better-newsletter/tree/main/examples/basic).

---

## Development Workflow

### Build & Typecheck

```bash
# Build all packages
pnpm build

# Typecheck all packages and fixtures
pnpm typecheck
```

### Tests & Quality Checks

Run the full verification suite before committing:

```bash
# Run lint, typecheck, build, migration checks, and tests in one command
pnpm check
```

Or run individual steps:

```bash
# Lint code
pnpm lint

# Run Vitest test suite
pnpm test

# Check that PostgreSQL migration SQL matches the canonical TypeScript schema model
pnpm migration:snapshot:check

# Update the migration SQL snapshot if the canonical schema model was intentionally changed
pnpm migration:snapshot:write
```

### Packed Artifact & Clean Consumer Smoke Tests

To verify that published packages contain only distributable files, pass `publint --strict`, satisfy `@arethetypeswrong/cli`, and install cleanly in isolated consumers:

```bash
node scripts/smoke-pack.mjs
```

---

## Releasing Packages

### Versioning Strategy

Better Newsletter uses **synchronized versioning** across packages:
- `better-newsletter` (runtime) and `@better-newsletter/cli` (CLI) share matching version numbers (e.g. `0.1.0-alpha.1`).
- `@better-newsletter/cli` maintains an exact dependency on the synchronized `better-newsletter` runtime version.

### Scopes & Permissions

- `better-newsletter`: Published as an unscoped package on npm.
- `@better-newsletter/cli`: Published under the `@better-newsletter` npm organization. Maintainers must be authenticated with an npm account that has publishing rights in the `better-newsletter` organization on npmjs.com.

### Local Release Flow

The maintainer explicitly decides **when** to release and **which version** to select:

```text
prepare → draft release PR → CI with PostgreSQL → review/squash-merge
        → CI on merged main commit → local publish
```

Run commands from the repository root, with dependencies installed using `pnpm install --frozen-lockfile`. **Neither release command requires a local PostgreSQL database or `DATABASE_URL`.** The existing GitHub CI provides PostgreSQL and runs the complete database/integration suite, including packed CLI SQL generation and migration checks. Local release validation does not use an inherited `DATABASE_URL`; CI replaces local database validation, **not** the local package/tarball/artifact checks.

Git must be able to fetch/push `origin`, which must point to this GitHub repository. Install and authenticate GitHub CLI (`gh auth login`) with permission to read Actions workflows/runs and create PRs and Releases. Publishing additionally requires `npm login --registry https://registry.npmjs.org` and permission to publish both packages. npm publication runs interactively: complete npm's browser authentication or 2FA/OTP challenge when requested. An appropriately authorized npm token must satisfy the registry's current 2FA policy; authentication failures stop publication, not the safety checks. Never commit tokens.

#### 1. Prepare from clean, current `main`

```bash
git switch main
git pull --ff-only origin main
pnpm release:prepare prerelease
```

Supported selectors are `prerelease`, `patch`, `minor`, `major`, or an explicit canonical SemVer such as `pnpm release:prepare 0.2.0-beta.1`. `prerelease` advances the current channel (`0.1.0-beta.1` becomes `0.1.0-beta.2`); entering prerelease from stable requires an explicit channel version. Other increments follow SemVer, including promoting `0.1.0-beta.1` to `0.1.0` with `patch`. Equal/older versions, build metadata and unsupported prerelease channels are rejected. Calling `pnpm release:prepare` without a selector retains the existing interactive `bumpp` prompt; cancelling it leaves files and the branch unchanged.

Preparation rejects tracked **and untracked** changes and a local `main` that differs from freshly fetched `origin/main`. It creates `release/v<version>`, uses the existing `bumpp` version update and `changelogen` release-note generation, synchronizes the exact CLI runtime dependency and updates `pnpm-lock.yaml`. Notes include Conventional Commits, Gitmoji and plain squash subjects since the last reachable tag; release commits are omitted. Each prepared entry records the exact preparation commit in a hidden `<!-- release-base: <SHA> -->` comment. Keep this marker intact when reviewing/editing the notes; it is omitted from the GitHub Release body.

The command checks the canonical SQL snapshot and independent revision/DDL-hash guard before changing versions, then runs lint, typecheck, build, migration snapshot verification and all DB-independent tests (excluding `test/postgres.test.ts` and `test/postgres-migration.test.ts`). It also runs the complete DB-independent packed-artifact/clean-consumer smoke. It never regenerates or approves schema changes. It commits the four release files, pushes the branch and opens a **draft** release PR. No tag or npm publication occurs. Review/edit the generated notes on the release branch, mark the PR ready, wait for PR CI including PostgreSQL, and squash-merge it. Then wait for CI to finish successfully on the new, merged `main` commit; green PR CI is not sufficient for publication.

If version updates or validation fail, the four release files are restored. When the working tree is clean and both the current release branch and `main` still point to the original preparation base, the command returns to `main` and removes its uncommitted local release branch with `git branch -d`. Fix the reported failure and retry the same selector. If other changes, commits or branch movements are detected, the branch/work are preserved and a manual recovery instruction is shown. Inspect `git status` and `git log main..release/v<version>`, preserve any work, then switch to `main` and remove the obsolete branch with `git branch -d release/v<version>`; never force-delete additional commits just to retry. Existing local release branches are rejected with this explicit recovery guidance. If commit/push/PR creation fails, the prepared state is preserved with the next recovery command. Check `gh pr list --head release/v<version>` before retrying PR creation to avoid duplicates.

#### 2. Publish the merged release commit

```bash
git switch main
git pull --ff-only origin main
pnpm release:publish
```

Publish immediately from the merged release commit, before another change lands on `main`. Publication requires a clean, current `main`, a version-bumping HEAD commit changing exactly the two package manifests, lockfile and changelog, synchronized versions/dependency, and matching prepared release notes. Additional code or other file changes in the release squash are rejected; merge them separately into `main` and regenerate the release instead. Editorial changelog adjustments remain allowed. The release commit's parent (`HEAD^`) must equal the recorded preparation base, so commits merged into `main` while the release PR was open cannot be published with stale notes. Missing, malformed or duplicate base markers are rejected. Existing local/remote tags, npm versions or GitHub Releases are rejected by default.

If `main` advances before merging the release PR, abandon the stale preparation and prepare again from updated `main` (choose a newer unused version if the original release branch still exists). Merely rebasing the old branch or editing its base marker is not sufficient. If a stale release was already merged, publication stops before tagging/publishing: prepare and merge a corrective release with a newer unused version from current `main`. This regenerates the complete unreleased changelog while leaving any reviewed historical entries intact. Never retarget the marker to bypass the guard.

Before local validation or any release mutation, publication requires successful GitHub CI for **exactly `HEAD`**. The repository policy identifies `.github/workflows/ci.yml` by filename, verifies its API identity/path and active state, and queries only `push` runs on `main` with `head_sha` equal to the checked commit. A successful run for another commit, workflow, branch or PR does not qualify.

When multiple relevant runs exist, the highest workflow `run_number` wins, with run ID and attempt as descending deterministic tie-breakers. GitHub reports the current attempt of a rerun, so a queued or failed rerun supersedes an older success. The selected run must be `status=completed` and `conclusion=success`. No run, queued/in-progress/waiting runs, failure, cancellation, timeout, neutral/skipped/action-required conclusions and GitHub/authentication/API errors all block publication. Paginated results must be complete and consistent; incomplete or changing listings block rather than guess.

Publication reruns the same DB-independent preparation checks (including migration/schema guards) and the complete local artifact smoke (build/pack, file/export checks, `publint`, `attw`, isolated runtime/CLI consumers and Nuxt handler). The exact two validated tarballs are retained temporarily and published, rather than rebuilding different artifacts.

After artifact validation and immediately before the first release mutation, publication rechecks clean/current `main`, unchanged `HEAD` and `origin/main`, and unchanged external tag/npm/GitHub Release state. It queries CI again for the original commit and requires the same successful workflow/run/attempt. A changed CI selection or attempt blocks even if the replacement is green; inspect it and retry so validation starts against the new CI evidence. Any failed race check prevents tag creation, npm publication and GitHub Release creation.

The script creates an annotated `v<version>` tag on the checked commit, recording both tarball SHA-512 integrities, and pushes the tag **before** npm publication. It publishes `better-newsletter` first and only publishes the CLI once the matching runtime/integrity is visible on npm. It then creates a GitHub Release using that version's changelog entry. Prereleases are marked as prereleases on GitHub.

| Version | Explicit npm dist-tag |
| --- | --- |
| `*-alpha.*` | `alpha` |
| `*-beta.*` | `beta` |
| `*-rc.*` | `rc` |
| Stable | `latest` |

Prereleases never use npm's implicit `latest`; the previous `next` convention is not used. GitHub's independent "Latest release" marker is left unchanged. Publishing is local only: GitHub Actions validates PRs and `main` with PostgreSQL, but never tags, publishes npm packages or creates GitHub Releases. There is no OIDC/trusted publishing or automatic release after merge.

#### Recovery after partial publication

Inspect the tag, npm versions and GitHub Release, then rerun on the **same exact clean/current main commit**:

```bash
pnpm release:publish --resume
```

Recovery requires the same exact-HEAD successful CI gate and final race checks, reruns DB-independent local validation, and checks the tag's commit/artifact manifest and any published package integrities. No local database is required. All existing integrity and ordering guarantees remain: it only performs missing steps; immutable npm versions are never overwritten or republished. Do not delete a valid pushed tag because a subsequent service failed.

| Failure | Recovery |
| --- | --- |
| Local tag exists but push failed | Fix Git authentication/connectivity; resume pushes the existing verified tag. |
| Tag push succeeded, npm publication failed | Fix npm authentication/2FA/connectivity; resume publishes the missing packages. |
| Runtime published, CLI failed | Wait for npm visibility or fix CLI permissions/2FA; resume skips the verified runtime and publishes only the CLI. |
| Both packages published, GitHub Release failed | Fix `gh` authentication/connectivity; resume skips both verified npm versions and creates only the Release. |

An interrupted successful external request is detected on retry even if the original command returned an error. A wrong tag commit, different tarball integrity, CLI published without runtime, or premature GitHub Release is refused for manual investigation. If `main` has advanced, normal recovery is deliberately blocked: do not move tags or force-push `main`; resolve the remaining external step manually from the tagged, validated artifacts after reviewing the failure.

Generic Git/SemVer/npm/GitHub mechanics, including `requireSuccessfulCi`, live in `scripts/release-core.mjs`; the required CI workflow identity, synchronized-package policy, release-commit evidence, `validatePreparation` and `validateArtifacts` live in `scripts/release-policy.mjs`. No shared npm release package is introduced.

## Schema revisions and releases

PostgreSQL's canonical target uses `POSTGRES_NEWSLETTER_SCHEMA.revision`, currently 1. Schema revisions belong to each dialect and must never be derived automatically from SemVer.

- **Package-only release:** change the synchronized npm package versions; leave the schema revision unchanged when no required database target changes. Runtime, API, documentation and Nuxt integration changes alone do not require a revision bump.
- **Schema-changing release:** deliberately increment the PostgreSQL revision when required DDL, ordered changes or data transformations change its target. Release notes must name the new revision and explain the migration requirement. Inspection alone must not be presented as proof that historical transformations ran.

`test/fixtures/postgres-schema-revision.json` checks the approved PostgreSQL revision and SHA-256 of the canonical DDL. Its regression fails with a maintenance message when either changes. Decide the revision policy first, then deliberately update this independent contract and document the required upgrade. Do not automatically refresh it when generating SQL or enlarge it into an automatic semantic DDL classifier.

The migration provider records a runtime-owned version derived from its package metadata; CLI-generated host SQL preserves this provenance, and the CLI never resolves a version independently. The canonical packaged snapshot identifies the dialect and schema revision and has no package-version header.

After intentionally changing the schema model, run `pnpm migration:snapshot:write` to refresh the packaged canonical SQL. Package-version changes do not require a snapshot update. This command intentionally does not update the independent revision/hash contract. Package-only provenance changes do not change the DDL hash. `pnpm check` verifies both contracts, and the packed smoke tests verify public metadata, initial/delta provenance and direct migration without a ledger.

Generated host migrations remain immutable. A package upgrade creates a new reviewed host migration against the previous applied schema; it never rewrites old host migration files. No database revision table is introduced by target metadata.
