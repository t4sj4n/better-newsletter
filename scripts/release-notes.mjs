import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { releasePackages } from './release-policy.mjs'
import { conciseMessage } from './script-errors.mjs'
import console from 'node:console'
import { generateMarkDown, getGitDiff, getLastGitTag, loadChangelogConfig, parseGitCommit } from 'changelogen'

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

export async function generatedNotes(cwd, version) {
  const from = await getLastGitTag(cwd)
  const config = await loadChangelogConfig(cwd, {
    from, to: 'HEAD', noAuthors: true, newVersion: version,
    types: { change: { title: 'Other changes' } }
  })
  const commits = releaseCommits(await getGitDiff(from || undefined, 'HEAD', cwd), config)
  return generateMarkDown(commits, config)
}

export async function updateChangelog(cwd, version, replaceCurrent = false) {
  const path = join(cwd, 'CHANGELOG.md')
  let previous = readFileSync(path, 'utf8').replace(/^# Changelog\s*/u, '')
  if (replaceCurrent && previous.startsWith(`## v${version}\n`)) {
    const next = previous.indexOf('\n## ', 1)
    previous = next < 0 ? '' : previous.slice(next + 1)
  }
  const entry = await generatedNotes(cwd, version)
  writeFileSync(path, `# Changelog\n\n${entry}\n\n${previous}`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    if (process.argv[2] === '--write') {
      const version = releasePackages(process.cwd())[0].version
      if (await getLastGitTag(process.cwd()) === `v${version}`) throw new Error('Do not regenerate notes for an already tagged version.')
      await updateChangelog(process.cwd(), version, true)
      console.log(`Updated release notes for v${version}; review and commit them before merging.`)
    } else {
      const notes = await generatedNotes(process.cwd(), 'preview')
      process.stdout.write(notes.replace(/^##[^\n]*\n/u, '').replace(/^\[compare changes\].*\n/gmu, '').trim() + '\n')
    }
  } catch (error) {
    console.error(conciseMessage(error.message))
    process.exitCode = 1
  }
}
