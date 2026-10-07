import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import semver from 'semver'
import { checked, prereleaseChannel, validVersion } from './release-core.mjs'

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
  prereleaseChannel(runtime.version)
  if (runtime.name !== 'better-newsletter' || cli.name !== '@better-newsletter/cli') {
    throw new Error('Unexpected runtime/CLI package names.')
  }
  if (runtime.version !== cli.version) throw new Error('Runtime and CLI versions must be synchronized.')
  if (cli.dependencies?.['better-newsletter'] !== `workspace:${runtime.version}`) {
    throw new Error('CLI must depend on the exact synchronized runtime version.')
  }
  return packages
}

export function releaseNotes(cwd, version) {
  const entries = readFileSync(join(cwd, 'CHANGELOG.md'), 'utf8').split(/^## /mu)
  if (!entries[1]?.startsWith(`v${version}\n`)) {
    throw new Error(`CHANGELOG.md must start with the prepared v${version} release.`)
  }
  // Legacy entries may still have preparation markers; they are not release evidence.
  return `## ${entries[1].replace(/^<!-- release-base: .* -->(?:\n\n|\n|$)/gmu, '').trim()}\n`
}

export async function requireReleaseCommit(run, packages) {
  for (const pkg of packages) {
    const previous = JSON.parse(await checked(run, 'git', ['show', `HEAD^:${pkg.path}`]))
    validVersion(previous.version)
    if (semver.compare(pkg.version, previous.version) <= 0) {
      throw new Error('Check out the commit that introduced this release version, rather than a later main commit.')
    }
  }
}

export function releaseArtifacts(cwd, packages) {
  return packages.map(pkg => {
    const filename = `${pkg.name.replace(/^@/u, '').replaceAll('/', '-')}-${pkg.version}.tgz`
    const path = join(cwd, filename)
    const integrity = `sha512-${createHash('sha512').update(readFileSync(path)).digest('base64')}`
    return { name: pkg.name, path, integrity }
  })
}
