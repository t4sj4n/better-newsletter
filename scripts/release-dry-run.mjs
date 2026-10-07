import { copyFileSync, cpSync, lstatSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { checked, liveCommandRunner, requireCleanTree } from './release-core.mjs'
import { releaseCommand } from './release-ui.mjs'

/** Release commands may validate and build in the copy, but never publish. */
export function dryRunCommandRunner(run) {
  return (command, args, options) => {
    const allowed = command === 'git'
      ? ['status', 'rev-parse', 'fetch', 'show', 'show-ref', 'ls-remote', 'cat-file', 'diff-tree'].includes(args[0])
        || (args[0] === 'branch' && args[1] === '--show-current')
        || (args[0] === 'remote' && args[1] === 'get-url')
      : command === 'npm' ? ['view', 'whoami'].includes(args[0])
        : command === 'gh' ? (args[0] === 'auth' && args[1] === 'status')
          || (args[0] === 'api' && !args.some(arg => /^(?:--(?:method|field|raw-field|input)(?:=|$)|-[XFf])/u.test(arg)))
          : command === 'pnpm' ? ['install', 'lint', 'typecheck', 'build', 'migration:snapshot:check'].includes(args[0])
            || args.join(' ') === '--filter better-newsletter build'
            || (args[0] === 'exec' && args[1] === 'vitest' && args[2] === 'run')
            : command === 'node' && args[0] === 'scripts/smoke-pack.mjs'
    if (!allowed) throw new Error(`Dry-run blocked a release mutation: ${command} ${args.join(' ')}`)
    return run(command, args, options)
  }
}

async function sourceCommit(run, skipGitChecks) {
  if (!skipGitChecks && await checked(run, 'git', ['branch', '--show-current']) !== 'main') {
    throw new Error('Releases must start on main. Run: git switch main')
  }
  return checked(run, 'git', ['rev-parse', 'HEAD'])
}

/** Detect changes made after snapshot setup without imposing release branch/base rules. */
export async function requireDryRunSnapshot(run) {
  await requireCleanTree(run)
  return checked(run, 'git', ['rev-parse', 'HEAD'])
}

async function copyWorkingTree(source, cwd, scratch, setup) {
  // Include HEAD paths so staged deletions also remove files from the clone.
  const paths = new Set([
    ...((await checked(setup, 'git', ['ls-files', '-z'])).split('\0')),
    ...((await checked(source, 'git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])).split('\0'))
  ].filter(Boolean))
  for (const path of paths) {
    const from = join(cwd, path)
    const to = join(scratch, path)
    rmSync(to, { recursive: true, force: true })
    const stat = lstatSync(from, { throwIfNoEntry: false })
    if (!stat) continue
    if (stat.isDirectory()) continue
    mkdirSync(dirname(to), { recursive: true })
    cpSync(from, to, { dereference: false, verbatimSymlinks: true })
  }
}

/** Treat copied local edits as the starting point, while still detecting validation edits. */
function snapshotCommandRunner(run, index) {
  return async (command, args, options) => {
    if (command !== 'git' || args.join(' ') !== 'status --porcelain') return run(command, args, options)
    const result = await run(command, args, {
      ...options, env: { ...process.env, ...options?.env, GIT_INDEX_FILE: index }
    })
    if (result.status !== 0) return result
    return {
      ...result,
      // The index contains the snapshot. Ignore its differences from HEAD, not new worktree changes.
      stdout: result.stdout.split('\n').filter(line => line && (line.startsWith('??') || line[1] !== ' '))
        .map(line => line.startsWith('??') ? line : ` ${line.slice(1)}`).join('\n')
    }
  }
}

function remoteUrl(cwd, url) {
  return /^(?:[a-z][a-z\d+.-]*:\/\/|[^/]+@[^:]+:)/iu.test(url) ? url : resolve(cwd, url)
}

/** Use separate Git metadata and dependencies; never share worktrees or node_modules. */
export async function withReleaseDryRun(cwd, { run = liveCommandRunner(cwd), runForDirectory = liveCommandRunner, ui, skipValidation = false, skipGitChecks = false }, action) {
  ui.warn(`Dry-run: ${skipValidation ? 'preview only' : 'full validation'} in a temporary copy; no release branch, commit, push, tag, PR or publication.`)
  if (skipValidation) ui.warn('Local validation and dependency installation are skipped. Artifacts are not verified; this preview does not establish release readiness.')
  if (skipGitChecks) ui.warn('Development dry-run: main, remote-base, release-branch availability, GitHub remote identity, prepared-commit, tag commit/manifest and CI checks are skipped. This run does not establish release readiness.')
  const commit = await ui.step('Checking source checkout', () => sourceCommit(run, skipGitChecks))
  if (await checked(run, 'git', ['status', '--porcelain'])) {
    ui.info('Including staged, unstaged and untracked files in the dry-run snapshot. Ignored files stay outside the copy.')
  }
  const scratch = mkdtempSync(join(tmpdir(), 'better-newsletter-dry-run-'))
  let result
  try {
    // Clone all refs (including local release branches) without shared objects or source hooks.
    const source = liveCommandRunner(cwd)
    const fetchUrl = remoteUrl(cwd, await checked(source, 'git', ['remote', 'get-url', 'origin']))
    const pushUrl = remoteUrl(cwd, await checked(source, 'git', ['remote', 'get-url', '--push', 'origin']))
    await ui.command(source, 'git', ['clone', '--mirror', '--no-hardlinks', '--', cwd, join(scratch, '.git')],
      { label: 'Copying repository for dry-run', completed: 'Repository copied for dry-run' })
    const setup = liveCommandRunner(scratch)
    await ui.step('Setting up isolated checkout', async () => {
      await checked(setup, 'git', ['config', 'core.bare', 'false'])
      await checked(setup, 'git', ['config', '--unset', 'remote.origin.mirror'])
      await checked(setup, 'git', ['config', 'remote.origin.url', fetchUrl])
      await checked(setup, 'git', ['config', 'remote.origin.pushurl', pushUrl])
      await checked(setup, 'git', ['config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'])
      await checked(setup, 'git', skipGitChecks ? ['checkout', '--detach', commit] : ['checkout', 'main'])
      if (await checked(setup, 'git', ['rev-parse', 'HEAD']) !== commit) {
        throw new Error('Source HEAD changed while creating the dry-run copy. Retry.')
      }
      await copyWorkingTree(source, cwd, scratch, setup)
      // Stage the snapshot only in the temporary repository; no synthetic commit or ref is created.
      await checked(setup, 'git', ['add', '--all', '--force', '--', '.'])
    })
    const index = join(scratch, '.git', 'dry-run-index')
    copyFileSync(join(scratch, '.git', 'index'), index)
    const isolatedRun = dryRunCommandRunner(snapshotCommandRunner(runForDirectory(scratch), index))
    const execute = releaseCommand(scratch, isolatedRun, ui)
    if (!skipValidation) {
      await execute('pnpm', ['install', '--frozen-lockfile'],
        { label: 'Installing dry-run dependencies', completed: 'Dry-run dependencies installed', env: { ...process.env, DATABASE_URL: '' } })
    }
    result = await action(scratch, isolatedRun)
    if (await sourceCommit(run, skipGitChecks) !== commit) throw new Error('Source HEAD changed during dry-run validation. Retry.')
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
  if (skipValidation) ui.warn('Dry-run preview complete; local validation was skipped.')
  else ui.success(skipGitChecks ? 'Local dry-run validation passed; Git and CI release checks were skipped.' : 'Dry-run validation passed')
  ui.finish(`Dry-run ${skipValidation ? 'preview complete' : 'complete'}; temporary copy removed. No release changes applied.`)
  return result
}
