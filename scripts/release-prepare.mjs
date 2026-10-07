import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { versionBump } from 'bumpp'
import { generateMarkDown, getGitDiff, getLastGitTag, loadChangelogConfig, parseGitCommit } from 'changelogen'
import { checked, createReleaseBranch, distTag, liveCommandRunner, nextVersion, npmVersion, removeUncommittedReleaseBranch, requireAvailableReleaseBranch, requireCleanTree, requireCurrentMain, requireGitHub, requireRemoteMain, tagState } from './release-core.mjs'
import { requireDryRunSnapshot, withReleaseDryRun } from './release-dry-run.mjs'
import { releaseNotes, releasePackages, releasePaths, repository, schemaChecks, validateArtifacts, validatePreparation } from './release-policy.mjs'
import { createReleaseUi, releaseCommand, runReleaseCli, selectReleaseVersion, validateReleaseOptions } from './release-ui.mjs'
import { runScriptChecks } from './script-core.mjs'

/** Preserve Gitmoji and plain squash titles alongside Conventional Commits. */
export function releaseCommits(commits, config) {
  const types = { '✨': 'feat', '🐛': 'fix', '💥': 'feat!', '📝': 'docs', '♻️': 'refactor', '⚡️': 'perf', '🧪': 'test' }
  return commits.flatMap(commit => {
    if (/^(?:🔖\s*release\b|chore\(release\):|chore:\s*release\b)/iu.test(commit.message)) return []
    // Squash subjects reference the issue before the final pull-request suffix.
    const subject = commit.message.replace(/\(#(\d+)\)(?=.*\(#\d+\)\s*$)/gu, '#$1')
    const [emoji, type] = Object.entries(types).find(([emoji]) => subject.startsWith(emoji)) ?? []
    const message = emoji ? `${type}: ${subject.slice(emoji.length).trim()}` : subject
    // Changelogen looks up author identities even with noAuthors; omit them for offline preparation.
    const raw = { ...commit, message: subject, author: { name: '', email: '' } }
    const parsed = parseGitCommit(raw, config)
      ?? parseGitCommit({ ...raw, message }, config)
      ?? parseGitCommit({ ...raw, message: `change: ${message}` }, config)
    return parsed ? [parsed] : []
  })
}

export async function prepareRelease(cwd, release = 'prompt', options = {}) {
  validateReleaseOptions(options)
  const { dryRun = false, ui = createReleaseUi({ enabled: false }) } = options
  if (dryRun) {
    return withReleaseDryRun(cwd, { ...options, ui }, (directory, run) =>
      prepareInDirectory(directory, release, { ...options, run, ui }))
  }
  return prepareInDirectory(cwd, release, { ...options, ui })
}

async function prepareInDirectory(cwd, release, {
  dryRun = false, skipValidation = false, skipGitChecks = false,
  run, selectVersion = selectReleaseVersion, ui = createReleaseUi({ enabled: false })
} = {}) {
  const execute = releaseCommand(cwd, run, ui)
  run ??= liveCommandRunner(cwd)
  const base = await ui.step(skipGitChecks ? 'Checking development snapshot' : dryRun ? 'Checking main and snapshot' : 'Checking clean main and repository',
    () => skipGitChecks ? requireDryRunSnapshot(run) : requireCurrentMain(run))
  const packages = releasePackages(cwd)
  const current = packages[0].version
  const selected = release === 'prompt'
    ? (await selectVersion({
        cwd, release: 'prompt', currentVersion: current, files: releasePaths.slice(0, 2),
        waitForInput: action => ui.input(action),
        preid: current.includes('-') ? distTag(current) : 'beta',
        commit: false, tag: false, push: false, noGitCheck: true, printCommits: false
      })).results.newVersion
    : release
  const version = nextVersion(current, selected)
  const branch = `release/v${version}`
  await ui.step('Checking version availability and GitHub access', async () => {
    const tag = await tagState(run, `v${version}`)
    if (tag.localCommit || tag.remoteCommit) throw new Error(`Tag v${version} already exists.`)
    for (const pkg of packages) {
      if (await npmVersion(run, pkg.name, version)) throw new Error(`${pkg.name}@${version} is already published.`)
    }
    if (skipGitChecks) await checked(run, 'gh', ['auth', 'status'])
    else await requireGitHub(run, repository)
  })
  ui.note([
    `Current version  ${current}`,
    `Next version     ${version}`,
    `Release branch   ${branch}`
  ].join('\n'), 'Release plan')
  const paths = releasePaths
  const originals = new Map(paths.map(path => [path, existsSync(join(cwd, path)) ? readFileSync(join(cwd, path)) : null]))

  // Validate the target without rewriting SQL or accepting a changed revision/hash guard.
  if (!skipValidation) {
    await runScriptChecks(schemaChecks, execute)
  }
  await execute('git', ['fetch', 'origin', '--tags'],
    { label: 'Fetching release history', completed: 'Release history fetched' })
  const { config, commits } = await ui.step('Collecting commits and release notes', async () => {
    const from = await getLastGitTag(cwd)
    const config = await loadChangelogConfig(cwd, {
      from, to: 'HEAD', noAuthors: true,
      types: { change: { title: 'Other changes' } }
    })
    const commits = releaseCommits(await getGitDiff(from || undefined, 'HEAD', cwd), config)
    return { config, commits }
  })
  if (!skipGitChecks) {
    await ui.step(dryRun ? `Checking availability of ${branch}` : `Creating ${branch}`,
      () => dryRun ? requireAvailableReleaseBranch(run, branch) : createReleaseBranch(run, branch))
  }

  try {
    await ui.step('Updating package versions', async () => {
      const result = await versionBump({
        cwd, release: version, currentVersion: packages[0].version,
        files: paths.slice(0, 2), confirm: false,
        commit: false, tag: false, push: false, noGitCheck: true, printCommits: false
      })
      if (result.newVersion !== version) throw new Error('Version preparation did not produce the selected release.')
      const updatedCli = JSON.parse(readFileSync(join(cwd, paths[1]), 'utf8'))
      updatedCli.dependencies['better-newsletter'] = `workspace:${result.newVersion}`
      writeFileSync(join(cwd, paths[1]), `${JSON.stringify(updatedCli, null, 2)}\n`)
    })
    if (skipValidation) ui.info('Skipping lockfile generation; real preparation will regenerate pnpm-lock.yaml.')
    else await execute('pnpm', ['install', '--lockfile-only', '--ignore-scripts'],
      { label: 'Updating dependency lockfile', completed: 'Dependency lockfile updated' })
    await ui.step('Updating changelog', async () => {
      config.newVersion = version
      const entry = await generateMarkDown(commits, config)
      const preparedEntry = entry.replace('\n', `\n\n<!-- release-base: ${base} -->\n`)
      const previous = originals.get('CHANGELOG.md')?.toString().replace(/^# Changelog\s*/u, '') ?? ''
      writeFileSync(join(cwd, 'CHANGELOG.md'), `# Changelog\n\n${preparedEntry}\n${previous ? `\n${previous}` : ''}`)
    })
    releaseNotes(cwd, version)
    releasePackages(cwd)
    if (!skipValidation) {
      await validatePreparation(run, execute)
      await validateArtifacts(run, undefined, execute)
    }
    await ui.step('Rechecking release base and changed files', async () => {
      if (skipGitChecks) {
        if (await checked(run, 'git', ['rev-parse', 'HEAD']) !== base) throw new Error('HEAD changed during dry-run validation.')
      } else await requireRemoteMain(run, base)
      const changes = (await checked(run, 'git', ['status', '--porcelain'])).split('\n').filter(Boolean)
      if (changes.some(line => !paths.includes(line.slice(3)))) {
        throw new Error('Validation changed files outside the release manifests, lockfile and changelog.')
      }
    })
  } catch (error) {
    if (dryRun) throw error
    for (const [path, contents] of originals) {
      if (contents === null) rmSync(join(cwd, path), { force: true })
      else writeFileSync(join(cwd, path), contents)
    }
    let removed
    try {
      removed = await removeUncommittedReleaseBranch(run, branch, base)
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], `Preparation failed; release files restored, but branch cleanup failed. Inspect git status and git branch --list ${branch}; preserve any work, then run git switch main and git branch -d ${branch} before retrying.`)
    }
    if (removed) {
      throw new Error(`Preparation failed; release files restored, returned to main and removed ${branch}. Fix the validation error, update main if needed, then retry: pnpm release:prepare ${version}`, { cause: error })
    }
    throw new Error(`Preparation failed; release files restored and ${branch} preserved because the branch, commit or working tree changed. Inspect git status and git log main..${branch}; preserve any work, then run git switch main and git branch -d ${branch} before retrying.`, { cause: error })
  }

  if (dryRun) {
    ui.note([
      `Create ${branch} from ${base}`,
      `Commit: 🔖 Release v${version}`,
      ...paths.map(path => `Update ${path}`),
      `Push ${branch} to origin`,
      `Open a draft pull request into main in ${repository}`
    ].join('\n'), 'Would prepare')
    ui.preview(releaseNotes(cwd, version), 'Release notes preview')
    return { version, branch, base, paths: [...paths], notes: releaseNotes(cwd, version),
      ...(skipValidation ? { validationSkipped: true } : {}),
      ...(skipGitChecks ? { gitChecksSkipped: true } : {}) }
  }

  const title = `🔖 Release v${version}`
  try {
    await ui.step('Committing the release files', async () => {
      await checked(run, 'git', ['add', '--', ...paths])
      await checked(run, 'git', ['commit', '-m', title])
      await requireCleanTree(run)
    })
  } catch (error) {
    throw new Error(`Release files remain on ${branch}. Inspect git status, finish the release commit, then run git push -u origin ${branch}.`, { cause: error })
  }
  const prArgs = ['pr', 'create', '--repo', repository, '--draft', '--base', 'main', '--head', branch,
    '--title', title, '--body', `Prepare synchronized v${version} packages and changelog.\n\nWait for PR CI (including PostgreSQL tests), review and squash-merge this PR, then wait for CI on the exact merged main commit before running \`pnpm release:publish\` locally. No tag or publication occurs during preparation.`]
  try {
    await execute('git', ['push', '-u', 'origin', branch],
      { label: 'Pushing release branch', completed: 'Release branch pushed' })
  } catch (error) {
    throw new Error(`Release commit is preserved. Next: git push -u origin ${branch}\nThen: gh pr create --draft --base main --head ${branch} --title "${title}"`, { cause: error })
  }
  try {
    const url = await ui.step('Opening a draft pull request', () => checked(run, 'gh', prArgs))
    ui.success(`Prepared v${version}`)
    ui.finish(`Release v${version} is ready · ${url}`)
  } catch (error) {
    throw new Error(`Release branch is pushed. Check gh pr list --head ${branch} before retrying:\ngh pr create --draft --base main --head ${branch} --title "${title}"`, { cause: error })
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await runReleaseCli('prepare', ({ release, dryRun, skipValidation, skipGitChecks, ui }) => prepareRelease(process.cwd(), release, { dryRun, skipValidation, skipGitChecks, ui }))
}
