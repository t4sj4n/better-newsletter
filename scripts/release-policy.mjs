import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import semver from 'semver'
import { checked, distTag, validVersion } from './release-core.mjs'

export const repository = 't4sj4n/better-newsletter'
export const releasePaths = [
  'packages/better-newsletter/package.json', 'packages/cli/package.json', 'pnpm-lock.yaml', 'CHANGELOG.md'
]

export function releasePackages(cwd) {
  const packages = releasePaths.slice(0, 2).map(path => ({
    ...JSON.parse(readFileSync(join(cwd, path), 'utf8')),
    path
  }))
  const [runtime, cli] = packages
  validVersion(runtime.version)
  distTag(runtime.version)
  if (runtime.name !== 'better-newsletter' || cli.name !== '@better-newsletter/cli') {
    throw new Error('Unexpected runtime/CLI package names.')
  }
  if (runtime.version !== cli.version) throw new Error('Runtime and CLI versions must be synchronized.')
  if (cli.dependencies?.['better-newsletter'] !== `workspace:${runtime.version}`) {
    throw new Error('CLI must depend on the exact synchronized runtime version.')
  }
  return packages
}

function preparedChangelogEntry(changelog, version) {
  const entries = changelog.split(/^## /mu)
  if (!entries[1]?.startsWith(`v${version}\n`)) {
    throw new Error(`CHANGELOG.md must start with the prepared v${version} release.`)
  }
  const entry = entries[1]
  const markers = entry.match(/^<!-- release-base:.*$/gmu) ?? []
  const base = markers.length === 1
    ? /^<!-- release-base: ([a-f0-9]{40}|[a-f0-9]{64}) -->$/u.exec(markers[0])?.[1]
    : undefined
  if (!base) throw new Error(`Prepared v${version} changelog must contain exactly one valid release-base SHA.`)
  return { base, notes: `## ${entry.replace(/^<!-- release-base: .* -->(?:\n\n|\n|$)/mu, '').trim()}\n` }
}

export function releaseNotes(cwd, version) {
  return preparedChangelogEntry(readFileSync(join(cwd, 'CHANGELOG.md'), 'utf8'), version).notes
}

export function requirePreparedCommit(run, packages) {
  const changed = checked(run, 'git', ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD']).split('\n')
  for (const path of releasePaths) {
    if (!changed.includes(path)) throw new Error(`HEAD is not a prepared release commit: missing change to ${path}.`)
  }
  for (const pkg of packages) {
    const committed = JSON.parse(checked(run, 'git', ['show', `HEAD:${pkg.path}`]))
    const previous = JSON.parse(checked(run, 'git', ['show', `HEAD^:${pkg.path}`]))
    validVersion(previous.version)
    if (committed.version !== pkg.version || semver.compare(pkg.version, previous.version) <= 0) {
      throw new Error('HEAD must contain the prepared version bump, not a later main commit.')
    }
  }
  const { base } = preparedChangelogEntry(checked(run, 'git', ['show', 'HEAD:CHANGELOG.md']), packages[0].version)
  if (checked(run, 'git', ['rev-parse', 'HEAD^']) !== base) {
    throw new Error('Prepared release base differs from HEAD^: main advanced before the release merge. Regenerate the release from current main with a newer unused version; do not retarget the release-base marker.')
  }
}

export function validateRelease(run, packDestination) {
  if (!process.env.DATABASE_URL) {
    throw new Error('Set DATABASE_URL to a disposable PostgreSQL database so release validation cannot skip database checks.')
  }
  checked(run, 'pnpm', ['check'])
  checked(run, 'node', ['scripts/smoke-pack.mjs', ...(packDestination ? ['--pack-destination', packDestination] : [])])
}

export function releaseArtifacts(cwd, packages) {
  return packages.map(pkg => {
    const filename = `${pkg.name.replace(/^@/u, '').replaceAll('/', '-')}-${pkg.version}.tgz`
    const path = join(cwd, filename)
    const integrity = `sha512-${createHash('sha512').update(readFileSync(path)).digest('base64')}`
    return { name: pkg.name, path, integrity }
  })
}
