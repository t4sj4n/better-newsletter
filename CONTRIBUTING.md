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

### Publishing to npm

1. Ensure the working tree is clean and `pnpm check` and `node scripts/smoke-pack.mjs` pass.
2. Bump the versions in `packages/better-newsletter/package.json` and `packages/cli/package.json` (and the `workspace:` dependency in `packages/cli/package.json`).
3. Publish all distributable packages from the monorepo root in a single command:

```bash
# For prereleases (alpha / beta / release candidates):
pnpm --filter "./packages/*" publish --tag next --no-git-checks

# For stable releases:
pnpm --filter "./packages/*" publish --no-git-checks
```

**What this command does automatically:**
- Resolves package dependencies topologically (`better-newsletter` runtime is published first, `@better-newsletter/cli` second).
- Executes `prepack` (`pnpm build`) to compile fresh distribution artifacts prior to packaging.
- Skips private workspace packages (`playground/`, `examples/basic/`).

The standalone StackBlitz consumer (`examples/basic/`) specifies `"better-newsletter": "latest"` and automatically resolves to the latest published release.
