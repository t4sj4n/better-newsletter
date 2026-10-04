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

### Publishing to npm (Step-by-Step)

Follow this structured workflow for every release:

#### 1. Prepare Release on a Branch
Create a release branch from `main`:
```bash
git checkout -b release/0.1.0-rc.1
```

#### 2. Prepare Versions and Changelog
Start with a clean tracked working tree on the release branch. Choose the next version interactively:
```bash
pnpm release:prepare
```

Or supply an explicit version:
```bash
pnpm release:prepare 0.1.0-rc.1
```

The command uses `bumpp` for version selection and updates both publishable package versions, the exact CLI runtime dependency and the lockfile. It uses `changelogen` to prepend release notes to `CHANGELOG.md` from commits since the latest reachable Git tag. Conventional Commits, Gitmoji subjects and plain squash-merge titles are included; release commits are omitted. Review the generated notes before committing.

Preparation checks the canonical SQL snapshot and the independent PostgreSQL revision/DDL-hash guard before changing versions. It never regenerates SQL or accepts schema changes. Cancelling the version prompt leaves files unchanged; errors during preparation restore package manifests, lockfile and changelog. The private workspace version and examples are not bumped. No commit, Git tag, push, merge or publication is performed by this command.

#### 3. Verify
Review the prepared diff and run the full test and packaging verification suite:
```bash
pnpm check
node scripts/smoke-pack.mjs
```

The canonical packaged SQL snapshot contains dialect and schema revision, without a runtime package version. A package-only release therefore requires no snapshot refresh. CLI-generated host migrations retain the generating runtime's version in their provenance header.

#### 4. Commit, PR, and Merge to `main`
```bash
git commit -am "🔖 Release 0.1.0-rc.1"
git push -u origin release/0.1.0-rc.1
gh pr create --title "🔖 Release 0.1.0-rc.1"
```
Wait for GitHub Actions CI checks to pass, then squash-merge the PR into `main`.

#### 5. Publish from `main`
Switch to `main` locally and pull the merged commit:
```bash
git checkout main
git pull origin main
```
Publish all distributable packages from the monorepo root in a single command:
```bash
# Standard release (updates the official 'latest' version on npm):
pnpm --filter "./packages/*" publish --no-git-checks

# Or for preview-only releases:
pnpm --filter "./packages/*" publish --tag next --no-git-checks
```

**What this command does automatically:**
- Resolves package dependencies topologically (`better-newsletter` runtime is published first, `@better-newsletter/cli` second).
- Executes `prepack` (`pnpm build`) to compile fresh distribution artifacts prior to packaging.
- Replaces `workspace:` protocol dependencies with exact published version numbers in the distributed tarball.
- Skips private workspace packages (`playground/`, `examples/basic/`).

#### 6. Tag the Release in Git
```bash
git tag v0.1.0-rc.1
git push origin v0.1.0-rc.1
```

## Schema revisions and releases

PostgreSQL's canonical target uses `POSTGRES_NEWSLETTER_SCHEMA.revision`, currently 1. Schema revisions belong to each dialect and must never be derived automatically from SemVer.

- **Package-only release:** change the synchronized npm package versions; leave the schema revision unchanged when no required database target changes. Runtime, API, documentation and Nuxt integration changes alone do not require a revision bump.
- **Schema-changing release:** deliberately increment the PostgreSQL revision when required DDL, ordered changes or data transformations change its target. Release notes must name the new revision and explain the migration requirement. Inspection alone must not be presented as proof that historical transformations ran.

`test/fixtures/postgres-schema-revision.json` checks the approved PostgreSQL revision and SHA-256 of the canonical DDL. Its regression fails with a maintenance message when either changes. Decide the revision policy first, then deliberately update this independent contract and document the required upgrade. Do not automatically refresh it when generating SQL or enlarge it into an automatic semantic DDL classifier.

The migration provider records a runtime-owned version derived from its package metadata; CLI-generated host SQL preserves this provenance, and the CLI never resolves a version independently. The canonical packaged snapshot identifies the dialect and schema revision and has no package-version header.

After intentionally changing the schema model, run `pnpm migration:snapshot:write` to refresh the packaged canonical SQL. Package-version changes do not require a snapshot update. This command intentionally does not update the independent revision/hash contract. Package-only provenance changes do not change the DDL hash. `pnpm check` verifies both contracts, and the packed smoke tests verify public metadata, initial/delta provenance and direct migration without a ledger.

Generated host migrations remain immutable. A package upgrade creates a new reviewed host migration against the previous applied schema; it never rewrites old host migration files. No database revision table is introduced by target metadata.
