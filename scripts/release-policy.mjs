import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import semver from 'semver'
import { checked, distTag, validVersion } from './release-core.mjs'
import { runScriptChecks } from './script-core.mjs'

export const repository = 't4sj4n/better-newsletter'
export const requiredCi = { workflow: 'ci.yml', event: 'push', branch: 'main' }
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

export async function requirePreparedCommit(run, packages) {
  const changed = (await checked(run, 'git', ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'])).split('\n')
  for (const path of releasePaths) {
    if (!changed.includes(path)) throw new Error(`HEAD is not a prepared release commit: missing change to ${path}.`)
  }
  const unexpected = changed.filter(path => !releasePaths.includes(path))
  if (unexpected.length) {
    throw new Error(`HEAD contains non-release file changes: ${unexpected.join(', ')}. Merge code changes separately and regenerate the release.`)
  }
  for (const pkg of packages) {
    const committed = JSON.parse(await checked(run, 'git', ['show', `HEAD:${pkg.path}`]))
    const previous = JSON.parse(await checked(run, 'git', ['show', `HEAD^:${pkg.path}`]))
    validVersion(previous.version)
    if (committed.version !== pkg.version || semver.compare(pkg.version, previous.version) <= 0) {
      throw new Error('HEAD must contain the prepared version bump, not a later main commit.')
    }
  }
  const { base } = preparedChangelogEntry(await checked(run, 'git', ['show', 'HEAD:CHANGELOG.md']), packages[0].version)
  if (await checked(run, 'git', ['rev-parse', 'HEAD^']) !== base) {
    throw new Error('Prepared release base differs from HEAD^: main advanced before the release merge. Regenerate the release from current main with a newer unused version; do not retarget the release-base marker.')
  }
}

const migrationSnapshotCheck = {
  command: 'pnpm', args: ['migration:snapshot:check'],
  label: 'Checking migration snapshot', completed: 'Migration snapshot checked'
}

export const schemaChecks = [
  { command: 'pnpm', args: ['--filter', 'better-newsletter', 'build'], label: 'Building runtime package', completed: 'Runtime package built' },
  migrationSnapshotCheck,
  { command: 'pnpm', args: ['exec', 'vitest', 'run', 'test/postgres-schema-revision.test.ts'], label: 'Checking schema revision', completed: 'Schema revision checked' }
]

export const preparationChecks = [
  { command: 'pnpm', args: ['lint'], label: 'Checking code style', completed: 'Code style checked' },
  { command: 'pnpm', args: ['typecheck'], label: 'Checking types', completed: 'Types checked' },
  { command: 'pnpm', args: ['build'], label: 'Building packages', completed: 'Packages built' },
  migrationSnapshotCheck,
  { command: 'pnpm', args: ['exec', 'vitest', 'run', '--exclude', 'test/postgres.test.ts', '--exclude', 'test/postgres-migration.test.ts'],
    label: 'Running release tests', completed: 'Release tests passed', env: { DATABASE_URL: '' } }
]

export function artifactChecks(packDestination) {
  return [{ command: 'node', args: ['scripts/smoke-pack.mjs', ...(packDestination ? ['--pack-destination', packDestination] : [])],
    label: 'Validating package artifacts', completed: 'Package artifacts validated', env: { DATABASE_URL: '' } }]
}

export async function validatePreparation(run, execute = (command, args, options) => checked(run, command, args, options)) {
  await runScriptChecks(preparationChecks, execute)
}

export async function validateArtifacts(run, packDestination, execute = (command, args, options) => checked(run, command, args, options)) {
  await runScriptChecks(artifactChecks(packDestination), execute)
}

export function releaseArtifacts(cwd, packages) {
  return packages.map(pkg => {
    const filename = `${pkg.name.replace(/^@/u, '').replaceAll('/', '-')}-${pkg.version}.tgz`
    const path = join(cwd, filename)
    const integrity = `sha512-${createHash('sha512').update(readFileSync(path)).digest('base64')}`
    return { name: pkg.name, path, integrity }
  })
}
