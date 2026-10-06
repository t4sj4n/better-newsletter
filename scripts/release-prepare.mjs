import console from 'node:console'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { versionBump, versionBumpInfo } from 'bumpp'
import { generateMarkDown, getGitDiff, getLastGitTag, loadChangelogConfig, parseGitCommit } from 'changelogen'
import { checked, commandRunner, createReleaseBranch, distTag, nextVersion, npmVersion, requireCleanTree, requireCurrentMain, requireGitHub, requireRemoteMain, tagState } from './release-core.mjs'
import { releaseNotes, releasePackages, releasePaths, repository, validateRelease } from './release-policy.mjs'

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

export async function prepareRelease(cwd, release = 'prompt', { run = commandRunner(cwd), selectVersion = versionBumpInfo } = {}) {
  const base = requireCurrentMain(run)
  const packages = releasePackages(cwd)
  const current = packages[0].version
  const selected = release === 'prompt'
    ? (await selectVersion({
        cwd, release: 'prompt', currentVersion: current, files: releasePaths.slice(0, 2),
        preid: current.includes('-') ? distTag(current) : 'beta',
        commit: false, tag: false, push: false, noGitCheck: true, printCommits: false
      })).results.newVersion
    : release
  const version = nextVersion(current, selected)
  const branch = `release/v${version}`
  const tag = tagState(run, `v${version}`)
  if (tag.localCommit || tag.remoteCommit) throw new Error(`Tag v${version} already exists.`)
  for (const pkg of packages) {
    if (npmVersion(run, pkg.name, version)) throw new Error(`${pkg.name}@${version} is already published.`)
  }
  requireGitHub(run, repository)
  const paths = releasePaths
  const originals = new Map(paths.map(path => [path, existsSync(join(cwd, path)) ? readFileSync(join(cwd, path)) : null]))

  // Validate the target without rewriting SQL or accepting a changed revision/hash guard.
  checked(run, 'pnpm', ['--filter', 'better-newsletter', 'build'])
  checked(run, 'pnpm', ['migration:snapshot:check'])
  checked(run, 'pnpm', ['exec', 'vitest', 'run', 'test/postgres-schema-revision.test.ts'])
  checked(run, 'git', ['fetch', 'origin', '--tags'])
  const from = await getLastGitTag(cwd)
  const config = await loadChangelogConfig(cwd, {
    from, to: 'HEAD', noAuthors: true,
    types: { change: { title: 'Other changes' } }
  })
  const commits = releaseCommits(await getGitDiff(from || undefined, 'HEAD', cwd), config)
  createReleaseBranch(run, branch)

  try {
    const result = await versionBump({
      cwd, release: version, currentVersion: packages[0].version,
      files: paths.slice(0, 2), confirm: false,
      commit: false, tag: false, push: false, noGitCheck: true, printCommits: false
    })
    if (result.newVersion !== version) throw new Error('Version preparation did not produce the selected release.')
    const updatedCli = JSON.parse(readFileSync(join(cwd, paths[1]), 'utf8'))
    updatedCli.dependencies['better-newsletter'] = `workspace:${result.newVersion}`
    writeFileSync(join(cwd, paths[1]), `${JSON.stringify(updatedCli, null, 2)}\n`)
    checked(run, 'pnpm', ['install', '--lockfile-only', '--ignore-scripts'])
    config.newVersion = result.newVersion
    const entry = await generateMarkDown(commits, config)
    const preparedEntry = entry.replace('\n', `\n\n<!-- release-base: ${base} -->\n`)
    const previous = originals.get('CHANGELOG.md')?.toString().replace(/^# Changelog\s*/u, '') ?? ''
    writeFileSync(join(cwd, 'CHANGELOG.md'), `# Changelog\n\n${preparedEntry}\n${previous ? `\n${previous}` : ''}`)
    releaseNotes(cwd, version)
    releasePackages(cwd)
    validateRelease(run)
    requireRemoteMain(run, base)
    const changes = checked(run, 'git', ['status', '--porcelain']).split('\n').filter(Boolean)
    if (changes.some(line => !paths.includes(line.slice(3)))) {
      throw new Error('Validation changed files outside the release manifests, lockfile and changelog.')
    }
  } catch (error) {
    for (const [path, contents] of originals) {
      if (contents === null) rmSync(join(cwd, path), { force: true })
      else writeFileSync(join(cwd, path), contents)
    }
    throw new Error(`Preparation failed; release files restored on ${branch}. Inspect the tree, then run git switch main before retrying.`, { cause: error })
  }

  const title = `🔖 Release v${version}`
  try {
    checked(run, 'git', ['add', '--', ...paths])
    checked(run, 'git', ['commit', '-m', title])
    requireCleanTree(run)
  } catch (error) {
    throw new Error(`Release files remain on ${branch}. Inspect git status, finish the release commit, then run git push -u origin ${branch}.`, { cause: error })
  }
  const prArgs = ['pr', 'create', '--repo', repository, '--draft', '--base', 'main', '--head', branch,
    '--title', title, '--body', `Prepare synchronized v${version} packages and changelog.\n\nReview and squash-merge this PR, then run \`pnpm release:publish\` from current main. No tag or publication occurs during preparation.`]
  try {
    checked(run, 'git', ['push', '-u', 'origin', branch])
  } catch (error) {
    throw new Error(`Release commit is preserved. Next: git push -u origin ${branch}\nThen: gh pr create --draft --base main --head ${branch} --title "${title}"`, { cause: error })
  }
  try {
    const url = checked(run, 'gh', prArgs)
    console.log(`Prepared v${version}: ${url}`)
  } catch (error) {
    throw new Error(`Release branch is pushed. Check gh pr list --head ${branch} before retrying:\ngh pr create --draft --base main --head ${branch} --title "${title}"`, { cause: error })
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2)
  if (args.length > 1) throw new Error('Usage: pnpm release:prepare [prerelease|patch|minor|major|version]')
  await prepareRelease(process.cwd(), args[0])
}
