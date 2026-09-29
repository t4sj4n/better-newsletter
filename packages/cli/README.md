# @better-newsletter/cli

Database migration commands for `better-newsletter`.

Install `better-newsletter` in the host application and add the CLI with `pnpm add -D @better-newsletter/cli`. Run `pnpm exec better-newsletter generate` or `pnpm exec better-newsletter migrate`; the one-off equivalent is `npx --package=@better-newsletter/cli better-newsletter migrate`. The CLI also accepts `--cwd`, `--config`, and `--yes` for non-interactive runs.

This bin-only package intentionally has no importable package-root API. For programmatic migrations, import from `better-newsletter/db/migration`.

See the [repository documentation](https://github.com/t4sj4n/better-newsletter#readme) for migration configuration.
