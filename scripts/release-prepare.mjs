import { execFileSync } from 'node:child_process'
import console from 'node:console'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { versionBump } from 'bumpp'
import { generateMarkDown, getGitDiff, getLastGitTag, loadChangelogConfig, parseGitCommit } from 'changelogen'

/** Preserve Gitmoji and plain squash titles alongside Conventional Commits. */
export function releaseCommits(commits, config) {
  const types = { '✨': 'feat', '🐛': 'fix', '💥': 'feat!', '📝': 'docs', '♻️': 'refactor', '⚡️': 'perf', '🧪': 'test' }
  return commits.flatMap(commit => {
    if (/^(?:🔖|chore(?:\(release\))?:)\s*release\b/iu.test(commit.message)) return []
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

export async function prepareRelease(cwd, release = 'prompt') {
  const run = (command, args, capture = false) => execFileSync(command, args, {
    cwd, ...(capture ? { encoding: 'utf8' } : { stdio: 'inherit' })
  })
  const branch = run('git', ['branch', '--show-current'], true).trim()
  if (!branch || branch === 'main') throw new Error('Prepare releases on a dedicated branch, not main or a detached HEAD.')
  if (run('git', ['status', '--porcelain', '--untracked-files=no'], true).trim()) {
    throw new Error('Commit or stash tracked changes before preparing a release.')
  }
  const paths = ['packages/better-newsletter/package.json', 'packages/cli/package.json', 'pnpm-lock.yaml', 'CHANGELOG.md']
  const originals = new Map(paths.map(path => [path, existsSync(join(cwd, path)) ? readFileSync(join(cwd, path)) : null]))
  const runtime = JSON.parse(originals.get(paths[0]).toString())
  const cli = JSON.parse(originals.get(paths[1]).toString())
  if (runtime.version !== cli.version || cli.dependencies['better-newsletter'] !== `workspace:${runtime.version}`) {
    throw new Error('Runtime, CLI and the exact CLI runtime dependency must already be synchronized.')
  }

  // Validate the target without rewriting SQL or accepting a changed revision/hash guard.
  run('pnpm', ['--filter', 'better-newsletter', 'build'])
  run('pnpm', ['migration:snapshot:check'])
  run('pnpm', ['exec', 'vitest', 'run', 'test/postgres-schema-revision.test.ts'])
  const from = await getLastGitTag(cwd)
  const config = await loadChangelogConfig(cwd, {
    from, to: 'HEAD', noAuthors: true,
    types: { change: { title: 'Other changes' } }
  })
  const commits = releaseCommits(await getGitDiff(from || undefined, 'HEAD', cwd), config)

  try {
    const result = await versionBump({
      cwd, release, currentVersion: runtime.version,
      files: paths.slice(0, 2), confirm: release === 'prompt',
      commit: false, tag: false, push: false, noGitCheck: true, printCommits: false
    })
    if (result.newVersion === runtime.version) throw new Error('Select a different release version.')
    const updatedCli = JSON.parse(readFileSync(join(cwd, paths[1]), 'utf8'))
    updatedCli.dependencies['better-newsletter'] = `workspace:${result.newVersion}`
    writeFileSync(join(cwd, paths[1]), `${JSON.stringify(updatedCli, null, 2)}\n`)
    run('pnpm', ['install', '--lockfile-only', '--ignore-scripts'])
    config.newVersion = result.newVersion
    const entry = await generateMarkDown(commits, config)
    const previous = originals.get('CHANGELOG.md')?.toString().replace(/^# Changelog\s*/u, '') ?? ''
    writeFileSync(join(cwd, 'CHANGELOG.md'), `# Changelog\n\n${entry}\n${previous ? `\n${previous}` : ''}`)
    console.log(`Prepared ${result.newVersion}. Review the diff and run pnpm check and the pack smoke before committing.`)
  } catch (error) {
    for (const [path, contents] of originals) {
      if (contents === null) rmSync(join(cwd, path), { force: true })
      else writeFileSync(join(cwd, path), contents)
    }
    throw error
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2)
  if (args.length > 1) throw new Error('Usage: pnpm release:prepare [version]')
  await prepareRelease(process.cwd(), args[0])
}
