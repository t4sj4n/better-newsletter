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

### Local Release Flow

Releases use `release-it` and `@release-it/bumper`, with native version selection, confirmations, status output and dry-runs. The private workspace root is never published. CI validates pull requests and `main`; it does not publish packages or create releases automatically.

Install dependencies with `pnpm install --frozen-lockfile`. Real releases require a clean checkout, including untracked files, and an `origin` push URL for this repository. Authenticate GitHub CLI (`gh auth login`); publishing also requires npm authentication and permission to publish both packages. `release-it` uses `GH_TOKEN`, `GITHUB_TOKEN`, or the existing `gh` login for the GitHub Release. Never commit tokens. npm publication inherits the terminal for browser/passkey or OTP authentication.

Neither release command requires a local PostgreSQL database. The complete quality, schema/revision, PostgreSQL and consumer checks run in CI. Prepare performs only release metadata checks. Publish installs frozen dependencies and validates the actual packed artifacts locally; it does not repeat lint, the complete test suite or a separate build sequence. Artifact validation deliberately ignores an inherited `DATABASE_URL`.

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

```bash
git switch main
git pull --ff-only origin main
pnpm release:publish
```

The selected `HEAD` must introduce the synchronized version bump, contain that version's reviewed changelog entry and be included in `origin/main`. It may change additional reviewed files; it need not change exactly four release files. The CI gate selects the newest `ci.yml` push run on `main` for this exact SHA and requires it to be completed and successful. Pending or failed reruns for that SHA block publication even if an older run succeeded; a newer successful run for the same SHA is accepted. Runs for other SHAs do not affect this check.

If another change has already landed on `main`, check out the actual release commit before publishing:

```bash
git switch --detach <release-commit-sha>
pnpm release:publish
```

Publication checks access and external release state, installs frozen dependencies and runs the packed-artifact smoke once. The exact validated tarballs and their commit/integrities are cached under Git's `newsletter-releases/<version>` metadata directory, outside the working tree. `release-it` creates an annotated tag containing this manifest. A `before:github:release` hook pushes only that tag, publishes the runtime first, verifies its matching integrity is visible, then publishes and verifies the CLI. The native GitHub plugin creates the Release from the reviewed notes. The cache is removed after successful completion; failures preserve it.

Native branch pushing is disabled in both phases. No command pushes a release commit directly to `main`.

Publication defaults to the npm dist-tag `latest` for both stable and prerelease versions. Choose a different tag explicitly when publishing a preview alongside the recommended version:

```bash
pnpm release:publish --tag next
pnpm release:publish --tag beta
```

The npm dist-tag is independent of the version's `alpha`, `beta` or `rc` identifier. Both packages receive the selected tag.

GitHub prerelease status follows the version; its independent Latest release marker is left unchanged.

#### Recovery

Keep valid tags and cached tarballs after a partial publication. Check out the original release commit, even if `main` has advanced:

```bash
git switch --detach <original-release-commit-sha>
pnpm release:publish --resume
```

When recovering a publication with a custom npm dist-tag, repeat the original option, for example `pnpm release:publish --resume --tag next`. Recovery skips already published packages; it does not retag them.

Recovery verifies tag identity, the recorded artifact manifest, cached files and existing npm integrities. It skips matching published packages and a complete existing GitHub Release. A CLI published without its runtime, a wrong tag/commit, conflicting integrity or premature/draft GitHub Release requires investigation. Immutable npm versions are never overwritten.

Cached tarballs avoid rebuilding after an interruption. If the cache is missing, artifact validation rebuilds it; the result must still match the tag manifest and any published package. Different results are refused. A clean checkout, inclusion of the original SHA in `main`, and successful exact-SHA CI remain required; the latest `main` tip and an unchanged CI run ID do not.

#### Previewing and developing release scripts

```bash
pnpm release:prepare prerelease --dry-run
pnpm release:publish --dry-run
pnpm release:publish --resume --dry-run
```

Dry-runs use native `release-it` behavior in the current checkout, including on dirty development branches. Our release-specific authentication, main/CI gates and artifact validation are skipped in previews. Version/package consistency still applies. No release branch, commit, tag, push, PR or publication is performed. This is a plan preview, not a full rehearsal or readiness check; `--resume --dry-run` also does not inspect which external steps have completed.

The old isolated snapshot and `--skip-validation`/`--skip-git-checks` options are removed. Run `pnpm check` and `node scripts/smoke-pack.mjs` separately for validation. Use a disposable checkout when testing real file-changing preparation. The native tool's general dry-run behavior does not promise filesystem isolation; our hooks are skipped and package publishing is disabled in the root configuration.

Use `--verbose` or `--debug` for command/debug output and stacks. Default failures are concise and exit non-zero. Focused tests cover our package contracts, publication ordering, integrity/recovery and previews; the old full Git-repository simulation suite is removed.

### Shared script helpers

The migration snapshot command continues using the reusable Clack helpers in `scripts/script-ui.mjs`, the command/check helpers in `scripts/script-core.mjs` and the CLI boundary in `scripts/script-cli.mjs`. Other scripts can use these helpers without inheriting release rules. Release commands use `scripts/release-cli.mjs` and the native `release-it` UI; repository-specific behavior lives in `scripts/release-workflow.mjs`, `scripts/release-hooks.mjs`, `scripts/release-policy.mjs` and `scripts/release-publication.mjs`.

## Schema revisions and releases

PostgreSQL's canonical target uses `POSTGRES_NEWSLETTER_SCHEMA.revision`, currently 1. Schema revisions belong to each dialect and must never be derived automatically from SemVer.

- **Package-only release:** change the synchronized npm package versions; leave the schema revision unchanged when no required database target changes. Runtime, API, documentation and Nuxt integration changes alone do not require a revision bump.
- **Schema-changing release:** deliberately increment the PostgreSQL revision when required DDL, ordered changes or data transformations change its target. Release notes must name the new revision and explain the migration requirement. Inspection alone must not be presented as proof that historical transformations ran.

`test/fixtures/postgres-schema-revision.json` checks the approved PostgreSQL revision and SHA-256 of the canonical DDL. Its regression fails with a maintenance message when either changes. Decide the revision policy first, then deliberately update this independent contract and document the required upgrade. Do not automatically refresh it when generating SQL or enlarge it into an automatic semantic DDL classifier.

The migration provider records a runtime-owned version derived from its package metadata; CLI-generated host SQL preserves this provenance, and the CLI never resolves a version independently. The canonical packaged snapshot identifies the dialect and schema revision and has no package-version header.

After intentionally changing the schema model, run `pnpm migration:snapshot:write` to refresh the packaged canonical SQL. Package-version changes do not require a snapshot update. This command intentionally does not update the independent revision/hash contract. Package-only provenance changes do not change the DDL hash. `pnpm check` verifies both contracts, and the packed smoke tests verify public metadata, initial/delta provenance and direct migration without a ledger.

Generated host migrations remain immutable. A package upgrade creates a new reviewed host migration against the previous applied schema; it never rewrites old host migration files. No database revision table is introduced by target metadata.
