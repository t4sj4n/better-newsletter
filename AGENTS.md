## Package Manager

- Use `pnpm` as the standard package manager unless I explicitly ask for a different one.

## Git Workflow

- Do not push directly to `main`.
- If we are on `main`, ask whether you should create a new branch first.
- Prefer squash merge for PRs unless I explicitly ask for a different merge strategy.
- Wait for my approval before pushing if the PR is not in draft mode.

## Issue Workflow

- When starting work for a GitHub issue, automatically move that issue to `In Progress` if the repository/project workflow supports it.
- For issue-based work, prefer a dedicated branch named after the issue number and a short slug, for example `feat/issue-25-ort-api-nutzen`.
- When opening a PR for an issue, include the closing keyword in the PR body, for example `Closes #25`. Do not rely on PR comments for automatic issue closing.
- Reference the issue number in the branch name, PR title, and any related handoff text so the work stays traceable.

## Gitmoji

- Use gitmoji for commit messages.
- Use exactly one gitmoji that matches the primary intent of the commit.
- Keep commit subjects short and clear; add a body when the rationale needs explanation.
- For details, see: https://github.com/carloscuesta/gitmoji/blob/master/AGENTS.md

## Language

- Use English for documentation, code comments, commit messages, PR text, and similar written project artifacts.
- Keep this rule even if the UI is in another language or the user writes in another language.
