# Contributing to Better Newsletter

Thank you for your interest in contributing to Better Newsletter! This document provides guidelines and commands for local development, testing, and package releases.

## Prerequisites

- **Node.js for development/releases**: `^22.22.2 || ^24.15.0 || >=26.0.0`, required by the release tooling. Published runtime and CLI packages retain their own `>=20.11` engine requirement.
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

# Typecheck runtime, CLI, and root TypeScript tests
pnpm typecheck
```

`pnpm typecheck` excludes `test/fixtures/**` and does not typecheck the playground or basic example. After building the packages, run the separate Nuxt consumer checks used in CI:

```bash
pnpm exec nuxt build test/fixtures/nuxt --logLevel=silent
pnpm --dir playground typecheck
pnpm --dir playground build
pnpm --dir examples/basic typecheck
pnpm --dir examples/basic build
```

### Tests & Quality Checks

Run the repository quality checks before committing:

```bash
# Run lint, typecheck, build, migration checks, and tests in one command
pnpm check
```

PostgreSQL integration tests require a running PostgreSQL database and `DATABASE_URL` pointing to a dedicated test database. Set this variable before running `pnpm check` or `pnpm test`; without it, PostgreSQL tests are skipped. CI uses PostgreSQL 16 and runs these tests, the separate Nuxt consumer checks above, packed-artifact smoke tests, and a Kysely compatibility matrix. A successful local `pnpm check` without `DATABASE_URL` does not establish the same coverage.

Or run individual steps:

```bash
# Lint code
pnpm lint

# Run Vitest test suite
pnpm test

# Build the current runtime schema before checking its SQL snapshot
pnpm --filter better-newsletter build
pnpm migration:snapshot:check

# Update the migration SQL snapshot if the canonical schema model was intentionally changed
pnpm migration:snapshot:write
```

`migration:snapshot:check` imports the compiled schema from `dist`, so always rebuild the runtime after schema changes before running it separately. `pnpm check` and `migration:snapshot:write` already include the required build.

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

### Release Flow

Releases use `release-it` and `@release-it/bumper` in two phases: prepare a release PR locally, then manually start the **Publish release** GitHub Actions workflow after merging. The private workspace root is never published. CI validates pull requests and `main`; merges alone do not trigger publication.

Install dependencies with `pnpm install --frozen-lockfile`. Real preparation requires a clean checkout, including untracked files, and an `origin` push URL for this repository. Authenticate GitHub CLI (`gh auth login`). GitHub Actions uses its built-in `GITHUB_TOKEN` for tags and GitHub Releases; npm publication uses Trusted Publishing (OIDC), with no stored npm token or browser/OTP prompts. The local `release:publish` package script has been removed.

#### One-time npm setup

For **each** package (`better-newsletter` and `@better-newsletter/cli`), add a GitHub Actions trusted publisher in its npm settings:

- Organization or user: `t4sj4n`
- Repository: `better-newsletter`
- Workflow filename: `publish.yml`
- Environment: leave empty (the workflow does not use a GitHub environment)
- Allowed actions: enable direct `npm publish`

See [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/) for the setup steps. The workflow uses a GitHub-hosted runner, Node.js 24.15.0, npm 11.21.0 and `id-token: write`. Do not configure `NPM_TOKEN` or `NODE_AUTH_TOKEN`; the publication guard rejects stored npm tokens. npm trusted publishing configuration is external to this repository and must be completed before a real publication.

Neither release phase requires a local PostgreSQL database. The complete quality, schema/revision, PostgreSQL and consumer checks run in CI. Prepare performs only release metadata checks. Publish installs frozen dependencies and validates the actual packed artifacts; it does not repeat lint, the complete test suite or a separate build sequence. Artifact validation deliberately ignores an inherited `DATABASE_URL`.

#### 1. Prepare a release PR

```bash
git switch main
git pull --ff-only origin main
pnpm release:prepare prerelease
```

Without a selector, an interactive terminal opens the native `release-it` version prompt. Supported selectors include `prerelease`, `patch`, `minor`, `major`, `prepatch`, `preminor`, `premajor`, or an explicit canonical version such as `0.2.0-beta.1`. Only newer versions and the `alpha`, `beta`, `rc` and stable channels are accepted; build metadata is rejected. Pass an explicit channel version when entering prerelease from a stable version. In non-interactive use, supply a version/selector; `--ci` disables confirmations.

Preparation starts from clean, current `main`, rejects existing release versions/tags/branches, and creates `release/v<version>`. The Bumper updates both package versions; a repository lifecycle plugin updates the exact `workspace:<version>` dependency, regenerates the lockfile and writes notes with the existing `changelogen` conventions. Conventional Commits, Gitmoji and plain squash subjects are included; prior release commits are omitted.

`release-it` commits the changes. An `after:release` hook pushes only the release branch and opens a draft PR. No release tag or npm publication occurs. Review the notes, mark the PR ready, wait for CI and squash-merge it. If `main` advances while the PR is open, update the release branch and review/regenerate the notes before merging. There is no preparation-parent SHA marker or mandatory new version merely because `main` advanced. To regenerate the current prepared entry after updating the branch, use:

```bash
pnpm release:notes
```

Preparation failures leave the release branch for inspection; native Git rollback may restore uncommitted tracked changes once the commit stage has started. Do not force-delete work to retry. For a failure after the release commit, inspect `git status`, push the existing release branch if necessary, and create the draft PR with `gh pr create --draft --base main --head release/v<version>`. Check `gh pr list --head release/v<version>` first to avoid duplicates.

#### 2. Publish the reviewed release commit

After merging the release PR and waiting for successful CI, open **Actions → Publish release → Run workflow**. Run the workflow from `main`, enter the full 40-character lowercase SHA of the commit that introduced the release version, select the npm dist-tag (default `latest`), and leave `resume` off for a new publication. You can also dispatch it through GitHub CLI:

```bash
gh workflow run publish.yml --ref main -f release_commit=<release-commit-sha> -f dist_tag=latest -F resume=false
```

The selected commit must introduce the synchronized version bump, contain that version's reviewed changelog entry and be included in `origin/main`. It may change additional reviewed files. The CI gate selects the newest `ci.yml` push run on `main` for this exact SHA and requires it to be completed and successful. Pending or failed reruns for that SHA block publication even if an older run succeeded; a newer successful run for the same SHA is accepted. Runs for other SHAs do not affect this check.

If `main` has advanced, still provide the original release commit. The workflow checks out the release tooling from the dispatched `main` revision and the selected release source separately. This allows current tooling to publish or recover older reviewed release commits without modifying them. Before installing dependencies, it verifies that the selected SHA belongs to `main`. Concurrent publications are serialized, and running workflows are never canceled by a new dispatch.

Publication checks external release state, installs frozen dependencies and runs the packed-artifact smoke once. Checked tarballs and their commit/integrities are cached under the release checkout's Git metadata. `release-it --ci` creates an annotated tag containing the artifact manifest. A `before:github:release` hook pushes only that tag, publishes the runtime first through npm/OIDC, verifies its matching integrity is visible, then publishes and verifies the CLI. The native GitHub plugin creates the Release from the reviewed notes. No release commit is pushed to `main`.

The npm dist-tag defaults to `latest` for both stable and prerelease versions. Set the workflow's `dist_tag` input to `next`, `beta` or another valid tag when publishing a preview alongside the recommended version. Both packages receive the selected tag. The npm tag is independent of the version's `alpha`, `beta` or `rc` identifier. GitHub prerelease status follows the version; its independent Latest release marker is left unchanged.

#### Recovery

Keep the release tag after a partial publication. The workflow preserves remaining checked tarballs and their manifest as an Actions artifact named `release-artifacts-<release-commit-sha>` for 30 days. To recover, dispatch **Publish release** from `main` again with the original `release_commit`, the original `dist_tag`, `resume=true`, and the failed run's numeric ID as `artifact_run_id`:

```bash
gh workflow run publish.yml --ref main -f release_commit=<original-release-commit-sha> -f dist_tag=latest -F resume=true -f artifact_run_id=<failed-run-id>
```

The run ID is the number in the Actions run URL. A rerun of the original job retains the original inputs; use a new dispatch to enable recovery and restore artifacts. If no cached artifacts exist (including a failure from the former local publisher), leave `artifact_run_id` empty. Artifact validation rebuilds the cache; its integrities must still match the annotated tag and any published package. Different results are refused.

Recovery verifies tag identity, the recorded artifact manifest, cached files and existing npm integrities. It skips matching published packages and a complete existing GitHub Release; it does not retag already published packages. A CLI published without its runtime, a wrong tag/commit, conflicting integrity or premature/draft GitHub Release requires investigation. Immutable npm versions are never overwritten. The original release SHA must still belong to `main` and have successful exact-SHA CI; neither the latest `main` tip nor an unchanged CI run ID is required.

#### Previewing and developing release scripts

```bash
pnpm release:prepare prerelease --dry-run
node scripts/release-publish.mjs --dry-run
node scripts/release-publish.mjs --resume --dry-run
```

Dry-runs use native `release-it` behavior in the current checkout, including on dirty development branches. Our release-specific authentication, main/CI gates and artifact validation are skipped in previews. Version/package consistency still applies. No release branch, commit, tag, push, PR or publication is performed. This is a plan preview, not a full rehearsal or readiness check; `--resume --dry-run` also does not inspect which external steps have completed.

The old isolated snapshot and `--skip-validation`/`--skip-git-checks` options are removed. Run `pnpm check` and `node scripts/smoke-pack.mjs` separately for validation. Use a disposable checkout when testing real file-changing preparation. The native tool's general dry-run behavior does not promise filesystem isolation; our hooks are skipped and package publishing is disabled in the root configuration.

Use `--verbose` or `--debug` for command/debug output and stacks. Default failures are concise and exit non-zero. Focused tests cover our package contracts, publication ordering, integrity/recovery and previews; the old full Git-repository simulation suite is removed.

### Shared script helpers

The migration snapshot command continues using the reusable Clack helpers in `scripts/script-ui.mjs`, the command/check helpers in `scripts/script-core.mjs` and the CLI boundary in `scripts/script-cli.mjs`. Other scripts can use these helpers without inheriting release rules. Release preparation and the Actions-only publisher use `scripts/release-cli.mjs` and the native `release-it` UI; repository-specific behavior lives in `scripts/release-workflow.mjs`, `scripts/release-hooks.mjs`, `scripts/release-policy.mjs` and `scripts/release-publication.mjs`. `scripts/npm-auth.mjs` verifies the trusted workflow and OIDC environment; npm itself exchanges the OIDC credentials.

## Schema revisions and releases

PostgreSQL's canonical target uses `POSTGRES_NEWSLETTER_SCHEMA.revision`, currently 1. Schema revisions belong to each dialect and must never be derived automatically from SemVer.

- **Package-only release:** change the synchronized npm package versions; leave the schema revision unchanged when no required database target changes. Runtime, API, documentation and Nuxt integration changes alone do not require a revision bump.
- **Schema-changing release:** deliberately increment the PostgreSQL revision when required DDL, ordered changes or data transformations change its target. Release notes must name the new revision and explain the migration requirement. Inspection alone must not be presented as proof that historical transformations ran.

`test/fixtures/postgres-schema-revision.json` checks the approved PostgreSQL revision and SHA-256 of the canonical DDL. Its regression fails with a maintenance message when either changes. Decide the revision policy first, then deliberately update this independent contract and document the required upgrade. Do not automatically refresh it when generating SQL or enlarge it into an automatic semantic DDL classifier.

The migration provider records a runtime-owned version derived from its package metadata; CLI-generated host SQL preserves this provenance, and the CLI never resolves a version independently. The canonical packaged snapshot identifies the dialect and schema revision and has no package-version header.

After intentionally changing the schema model, run `pnpm migration:snapshot:write` to refresh the packaged canonical SQL. Package-version changes do not require a snapshot update. This command intentionally does not update the independent revision/hash contract. Package-only provenance changes do not change the DDL hash. `pnpm check` verifies both contracts, and the packed smoke tests verify public metadata, initial/delta provenance and direct migration without a ledger.

Generated host migrations remain immutable. A package upgrade creates a new reviewed host migration against the previous applied schema; it never rewrites old host migration files. No database revision table is introduced by target metadata.
