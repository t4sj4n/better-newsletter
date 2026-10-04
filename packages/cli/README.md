# @better-newsletter/cli

Database migration commands for `better-newsletter`.

Install `better-newsletter` in the host application and add the CLI with `pnpm add -D @better-newsletter/cli`. Run `pnpm exec better-newsletter generate` or `pnpm exec better-newsletter migrate`; the one-off equivalent is `npx --package=@better-newsletter/cli better-newsletter migrate`. The CLI also accepts `--cwd`, `--config`, and `--yes` for non-interactive runs.

This bin-only package intentionally has no importable package-root API. For programmatic migrations, import from `better-newsletter/db/migration`.

See the [repository documentation](https://github.com/t4sj4n/better-newsletter#readme) for migration configuration.

Generated SQL records the installed **runtime** package version, dialect, target schema revision and initial/delta plan kind in deterministic comments. There are no timestamps or connection credentials. PostgreSQL currently targets revision 1 independently of npm versioning. This describes the package target, not a stored or verified database revision: both commands continue to inspect the actual database. Commit generated files as immutable host migrations and generate a new file when an upgrade requires changes. Direct `migrate` applies the inspected plan without creating a revision ledger.
