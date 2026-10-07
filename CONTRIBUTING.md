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

Both release commands use Clack status messages and live task logs. Each command has a descriptive step heading with its spinner beside it; the command appears below with a `$` prefix and dimmed output. Completed steps use `◆` and collapse their command logs unless verbose output is enabled. Long command/output lines wrap inside the left guide. Animations run in interactive terminals; redirected output and CI use static logs. npm publication keeps direct terminal access for browser/OTP authentication. Failures show the root cause and recovery instructions with a non-zero exit code. Add `--verbose` or `--debug` to either command to retain command logs and show stack traces and diagnostic details.

Steps show elapsed time while running and on completion or failure. The boxed run summary includes total elapsed time, execution time excluding Clack input prompts, prompt wait time, step outcomes, the number of logged commands, and the three slowest steps. Timings use a monotonic clock and include subprocess and network waits; they do not measure CPU usage. npm manages its own authentication, so browser/OTP waits remain part of command execution time. Summaries also appear after failures and cancellations. Release notes previews print in full, with wrapped lines and normal contrast, and remain available in terminal scrollback without `--verbose`. Vitest failures highlight the failed tests or suites and their actual error messages from either output stream; expected test logs do not replace the failure reason. Full command output and diagnostic details remain available with `--verbose` or `--debug`.

Use `--dry-run` for a fully validated preview:

```bash
pnpm release:prepare prerelease --dry-run
pnpm release:publish --dry-run
pnpm release:publish --resume --dry-run
```

For a faster plan and CLI preview, add `--skip-validation`:

```bash
pnpm release:prepare prerelease --dry-run --skip-validation
pnpm release:publish --dry-run --skip-validation
pnpm release:publish --resume --dry-run --skip-validation
```

This option requires `--dry-run`; both CLI and reusable release functions reject it for real releases before running any commands. The preview skips dependency installation, lockfile regeneration, lint, typecheck, builds, schema/snapshot checks, tests and packed-artifact smoke. Prepare still generates versions and release notes in the temporary copy; the displayed lockfile change is planned rather than generated. Without `--skip-git-checks`, Publish still requires a prepared release commit and successful CI on its exact SHA. By default, Git/main, version, authentication, release-state and race checks still run, so this mode requires GitHub/npm access. It reports skipped validation explicitly and does not generate artifact integrities or verify recovery tag manifests or published artifact integrity. A successful preview is not evidence of release readiness.

When developing the release scripts on a feature branch, add `--skip-git-checks` to the dry-run:

```bash
pnpm release:prepare prerelease --dry-run --skip-git-checks
pnpm release:publish --dry-run --skip-git-checks
# Fast CLI previews without local validation:
pnpm release:prepare prerelease --dry-run --skip-git-checks --skip-validation
pnpm release:publish --dry-run --skip-git-checks --skip-validation
```

This development option accepts any branch or detached HEAD, including local commits ahead of `main`, and snapshots staged, unstaged and untracked changes. It skips the `main`/remote-base requirements, release-branch availability, GitHub remote identity, prepared-release-commit checks, recovery tag commit/manifest checks and GitHub CI gates. Git is still required to copy the checkout, read release history and fetch tags. The current snapshot HEAD remains the base; it is never replaced with `main` or a synthetic commit. Local validation still runs unless `--skip-validation` is also supplied, and unexpected changes introduced by validation still fail. The output explicitly marks the skipped Git/CI requirements; passing local checks does not establish release readiness. Both CLI and reusable functions reject `--skip-git-checks` without `--dry-run`.

Package/version, changelog, authentication, npm/GitHub release-state and race checks remain active. For Publish, the current version still needs a valid changelog entry. If its tag, npm packages or GitHub Release already exist, add `--resume` to inspect the remaining steps; for example, `pnpm release:publish --resume --dry-run --skip-git-checks --skip-validation`. A development recovery preview may inspect an existing tag from an earlier commit, and marks its commit/manifest as unverified.

Dry-runs allow uncommitted changes so you can test the scripts before committing. Unless `--skip-git-checks` is supplied, they require current `main`. They copy the Git refs and current working-tree files (including staged, unstaged and untracked changes and deletions) into a temporary repository, and exclude ignored files such as existing dependencies and build output. By default, the copy installs its own dependencies with `pnpm install --frozen-lockfile` and runs the normal local checks and packed-artifact smoke against that snapshot. Initial local edits are accepted; unexpected edits made by validation still fail. Fetches, version/changelog edits, lockfile updates and build output stay in that copy; the source checkout's files, staging area, branches, tags and refs remain unchanged. The temporary copy is removed on success or failure. Real releases still require a clean working tree.

Dry-runs still query GitHub/npm. Without `--skip-git-checks`, they retain the release-commit, recovery tag and CI guards. For publication without that development option, successful GitHub CI must match the committed `HEAD`; it does not validate your uncommitted edits, which are checked locally in the copy unless validation is explicitly skipped. Dry-run success does not replace committing your changes and rerunning validation before a real release. Without `--skip-validation`, both commands take as long as full validation and may download dependencies.

Prepare previews the next version, generated release notes, changed paths, branch, commit and draft PR. Publish previews the tag, npm packages/dist-tag and GitHub Release; `--resume --dry-run` checks existing release state and shows only missing steps. Artifact verification runs unless explicitly skipped. Neither command creates a release branch, commit, tag or PR, pushes, or publishes anything during a dry-run. Failed checks still exit non-zero. Publication visibility and authentication challenges that occur during actual publishing can only be checked in the real run.

Run commands from the repository root, with dependencies installed using `pnpm install --frozen-lockfile`. **Neither release command requires a local PostgreSQL database or `DATABASE_URL`.** The existing GitHub CI provides PostgreSQL and runs the complete database/integration suite, including packed CLI SQL generation and migration checks. Local release validation does not use an inherited `DATABASE_URL`; CI replaces local database validation, **not** the local package/tarball/artifact checks.

Git must be able to fetch/push `origin`, which must point to this GitHub repository. Install and authenticate GitHub CLI (`gh auth login`) with permission to read Actions workflows/runs and create PRs and Releases. Publishing additionally requires `npm login --registry https://registry.npmjs.org` and permission to publish both packages. npm publication runs interactively: complete npm's browser authentication or 2FA/OTP challenge when requested. An appropriately authorized npm token must satisfy the registry's current 2FA policy; authentication failures stop publication, not the safety checks. Never commit tokens.

#### 1. Prepare from clean, current `main`

```bash
git switch main
git pull --ff-only origin main
pnpm release:prepare prerelease
```

Supported selectors are `prerelease`, `patch`, `minor`, `major`, or an explicit canonical SemVer such as `pnpm release:prepare 0.2.0-beta.1`. `prerelease` advances the current channel (`0.1.0-beta.1` becomes `0.1.0-beta.2`); entering prerelease from stable requires an explicit channel version. Other increments follow SemVer, including promoting `0.1.0-beta.1` to `0.1.0` with `patch`. Equal/older versions, build metadata and unsupported prerelease channels are rejected. Calling `pnpm release:prepare` without a selector opens a Clack version selector using the existing `bumpp` version calculations; cancelling it leaves files and the branch unchanged. In non-interactive environments, pass a selector or explicit version.

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

Generic Git/SemVer/npm/GitHub mechanics, including `requireSuccessfulCi`, live in `scripts/release-core.mjs`; the required CI workflow identity, synchronized-package policy, release-commit evidence, and shared `schemaChecks`, `preparationChecks` and `artifactChecks(packDestination)` definitions live in `scripts/release-policy.mjs`. `validatePreparation` and `validateArtifacts` execute those definitions. Release version prompts and CLI adapters live in `scripts/release-ui.mjs`. Temporary repository isolation and the release-specific dry-run command guard live in `scripts/release-dry-run.mjs`. No shared npm release package is introduced.

#### Reusing script conventions

Repository scripts share three small modules:

| Module | Reusable behavior |
| --- | --- |
| `scripts/script-ui.mjs` | `createScriptUi`, intro/outro, descriptive step spinners, live command logs, colors, wrapping, full previews, per-step timings, boxed run summaries, prompt waits, cancellation and concise root-cause errors. |
| `scripts/script-core.mjs` | `liveCommandRunner`, `commandRunner`, `checked`, `checkedResult` and sequential `runScriptChecks`. |
| `scripts/script-cli.mjs` | `runScriptCli`, boolean flag/positional parsing, common `--verbose`/`--debug` definitions, opt-in dry-run flags and validation of their dependencies. |

Prepare, Publish and the migration snapshot command use these shared components. Existing exports from `release-core.mjs` and `release-ui.mjs` remain compatible. Release policy stays separate from generic presentation; a new script does not inherit release prerequisites or package/version prompts.

For example, a script can reuse the complete CLI presentation and its own check definitions:

```js
import process from 'node:process'
import { runScriptCli } from './script-cli.mjs'
import { runScriptChecks } from './script-core.mjs'
import { scriptCommand } from './script-ui.mjs'

const checks = [
  { command: 'pnpm', args: ['lint'], label: 'Checking code style', completed: 'Code style checked' }
]

await runScriptCli({ title: 'quality checks' }, async ({ ui }) => {
  const execute = scriptCommand(process.cwd(), undefined, ui)
  await runScriptChecks(checks, execute)
  ui.finish('Quality checks passed.')
})
```

Use `ui.step(label, action)` for short asynchronous work, `ui.command` or `scriptCommand` for subprocesses, and `ui.input(() => confirm(...))` or `ui.input(() => select(...))` for Clack prompts. Prompt cancellation exits with code 130 and input waits are measured automatically. Use `ui.preview` for full scrollback output and `ui.finish` to emit the summary/outro once. `createScriptUi({ name: 'another-tool' })` changes the intro brand. Boolean flag extensions use `parseScriptArgs(args, { flags: { '--write': 'write' }, maxPositionals: 0, usage })`, which returns `{ options, positionals }`; a CLI parser passed to `runScriptCli` returns the desired options object.

Command definitions contain `command`, `args`, `label`, `completed`, and optional runner options such as `env`. `runScriptChecks` preserves their order, inherits the current environment and overlays each check's `env`, and stops at the first error. Reuse the exported release check groups when another script needs that same policy. `runScriptCli` owns the failure boundary and non-zero exit status; reusable functions should throw errors, including `ScriptCancelled`, rather than calling `process.exit`.

Dry-run flags are opt-in: import `dryRunFlags` and `validateScriptOptions` only after implementing isolation and an appropriate command guard for that script. Accepting those flags does not itself provide isolation or skip any work. The existing `withReleaseDryRun` and its allowlist are specific to release operations. Real runs reject both skip flags; the release adapters retain every existing release rule.


## Schema revisions and releases

PostgreSQL's canonical target uses `POSTGRES_NEWSLETTER_SCHEMA.revision`, currently 1. Schema revisions belong to each dialect and must never be derived automatically from SemVer.

- **Package-only release:** change the synchronized npm package versions; leave the schema revision unchanged when no required database target changes. Runtime, API, documentation and Nuxt integration changes alone do not require a revision bump.
- **Schema-changing release:** deliberately increment the PostgreSQL revision when required DDL, ordered changes or data transformations change its target. Release notes must name the new revision and explain the migration requirement. Inspection alone must not be presented as proof that historical transformations ran.

`test/fixtures/postgres-schema-revision.json` checks the approved PostgreSQL revision and SHA-256 of the canonical DDL. Its regression fails with a maintenance message when either changes. Decide the revision policy first, then deliberately update this independent contract and document the required upgrade. Do not automatically refresh it when generating SQL or enlarge it into an automatic semantic DDL classifier.

The migration provider records a runtime-owned version derived from its package metadata; CLI-generated host SQL preserves this provenance, and the CLI never resolves a version independently. The canonical packaged snapshot identifies the dialect and schema revision and has no package-version header.

After intentionally changing the schema model, run `pnpm migration:snapshot:write` to refresh the packaged canonical SQL. Package-version changes do not require a snapshot update. This command intentionally does not update the independent revision/hash contract. Package-only provenance changes do not change the DDL hash. `pnpm check` verifies both contracts, and the packed smoke tests verify public metadata, initial/delta provenance and direct migration without a ledger.

Generated host migrations remain immutable. A package upgrade creates a new reviewed host migration against the previous applied schema; it never rewrites old host migration files. No database revision table is introduced by target metadata.
