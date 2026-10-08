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
- [`examples/basic/`](examples/basic/): Minimal copyable Nuxt 4 consumer demonstrating the Double Opt-In lifecycle, also used for the [StackBlitz demo](https://stackblitz.com/github/t4sj4n/better-newsletter/tree/main/examples/basic). In `examples/basic/package.json`, `"better-newsletter": "beta"` is specified during prereleases so standalone StackBlitz instances always load the newest published prerelease from npm. Inside this workspace, the root `package.json` configures a `pnpm.overrides` rule (`better-newsletter-basic-example>better-newsletter: workspace:*`) so local branch development and CI typechecks run directly against the local workspace package without manual switching.

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
- Workflow filename: `release.yml`
- Environment: leave empty (the workflow does not use a GitHub environment)
- Allowed actions: enable direct `npm publish`

See [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/) for the setup steps. The workflow uses Node.js, `pnpm`, and `id-token: write` to exchange OIDC credentials with npm. Do not configure static tokens (`NPM_TOKEN` or `NODE_AUTH_TOKEN`).

#### 1. Create a release locally

From `main` with a clean working tree:

```bash
git switch main
git pull --ff-only origin main
pnpm release
```

`pnpm release` runs an interactive prompt powered by `bumpp`:
- Select the release increment (e.g. `patch`, `minor`, `major`, or `prerelease` with pre-id `beta`/`alpha`/`rc`).
- Bumps versions synchronically across `packages/better-newsletter` and `packages/cli`.
- Synchronizes the CLI `workspace:<version>` dependency and updates `pnpm-lock.yaml`.
- Updates `CHANGELOG.md` with categorized changes since the last release tag via `changelogen`.
- Creates a release commit (`🔖 Release v<version>`) and git tag (`v<version>`).

#### 2. Push and publish

Push the release commit and tag to GitHub:

```bash
git push origin main --follow-tags
```

The GitHub Actions release workflow (`.github/workflows/release.yml` -> `reusable-release.yml`) automatically triggers on `v*` tag pushes:
1. Validates repository quality checks (`pnpm check`) and runs the packed-artifact smoke tests (`node scripts/smoke-pack.mjs`).
2. Detects pre-release channels (`alpha`, `beta`, `rc`) from the tag name and assigns the matching npm dist-tag (stable releases default to `latest`).
3. Extracts the exact release notes entry from `CHANGELOG.md` via `scripts/extract-release-notes.mjs` and creates the GitHub Release with 100% identical notes.
4. Publishes all workspace packages to npm via OIDC Trusted Publishing with `--provenance`.

### Shared script helpers

The migration snapshot command continues using the reusable Clack helpers in `scripts/script-ui.mjs`, the command/check helpers in `scripts/script-core.mjs` and the CLI boundary in `scripts/script-cli.mjs`. Other scripts can use these helpers without inheriting release rules. Release creation uses `scripts/release.mjs` and `scripts/release-notes.mjs`, and release notes extraction uses `scripts/extract-release-notes.mjs`.

## Schema revisions and releases

PostgreSQL's canonical target uses `POSTGRES_NEWSLETTER_SCHEMA.revision`, currently 1. Schema revisions belong to each dialect and must never be derived automatically from SemVer.

- **Package-only release:** change the synchronized npm package versions; leave the schema revision unchanged when no required database target changes. Runtime, API, documentation and Nuxt integration changes alone do not require a revision bump.
- **Schema-changing release:** deliberately increment the PostgreSQL revision when required DDL, ordered changes or data transformations change its target. Release notes must name the new revision and explain the migration requirement. Inspection alone must not be presented as proof that historical transformations ran.

`test/fixtures/postgres-schema-revision.json` checks the approved PostgreSQL revision and SHA-256 of the canonical DDL. Its regression fails with a maintenance message when either changes. Decide the revision policy first, then deliberately update this independent contract and document the required upgrade. Do not automatically refresh it when generating SQL or enlarge it into an automatic semantic DDL classifier.

The migration provider records a runtime-owned version derived from its package metadata; CLI-generated host SQL preserves this provenance, and the CLI never resolves a version independently. The canonical packaged snapshot identifies the dialect and schema revision and has no package-version header.

After intentionally changing the schema model, run `pnpm migration:snapshot:write` to refresh the packaged canonical SQL. Package-version changes do not require a snapshot update. This command intentionally does not update the independent revision/hash contract. Package-only provenance changes do not change the DDL hash. `pnpm check` verifies both contracts, and the packed smoke tests verify public metadata, initial/delta provenance and direct migration without a ledger.

Generated host migrations remain immutable. A package upgrade creates a new reviewed host migration against the previous applied schema; it never rewrites old host migration files. No database revision table is introduced by target metadata.
