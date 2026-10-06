import { execFileSync } from 'node:child_process'
import semver from 'semver'

export const registry = 'https://registry.npmjs.org'

export function commandRunner(cwd) {
  return (command, args, options = {}) => {
    try {
      return { status: 0, stdout: execFileSync(command, args, {
        cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'], ...options
      }) ?? '', stderr: '' }
    } catch (error) {
      if (typeof error.status !== 'number') {
        throw new Error(`Cannot run ${command}. Install/authenticate it before retrying.`, { cause: error })
      }
      return { status: error.status, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') }
    }
  }
}

export function checked(run, command, args, options) {
  const result = run(command, args, options)
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed:\n${result.stderr || result.stdout}`)
  }
  return result.stdout.trimEnd()
}

export function validVersion(version) {
  if (typeof version !== 'string' || semver.valid(version) !== version || version.includes('+')) {
    throw new Error(`Invalid release SemVer: ${version}. Use a canonical version without build metadata.`)
  }
  return version
}

export function distTag(version) {
  validVersion(version)
  const prerelease = semver.prerelease(version)
  if (!prerelease) return 'latest'
  const channel = prerelease[0]
  if (!['alpha', 'beta', 'rc'].includes(channel)) {
    throw new Error(`Unsupported prerelease channel: ${channel}. Use alpha, beta or rc.`)
  }
  return channel
}

export function nextVersion(current, release) {
  validVersion(current)
  if (release === 'prerelease' && !semver.prerelease(current)) {
    throw new Error('prerelease requires an existing prerelease; select an explicit alpha, beta or rc version.')
  }
  const version = ['prerelease', 'patch', 'minor', 'major'].includes(release)
    ? semver.inc(current, release)
    : release
  validVersion(version)
  if (semver.compare(version, current) <= 0) {
    throw new Error('Select a release version newer than the current version.')
  }
  distTag(version)
  return version
}

export function requireCleanTree(run) {
  if (checked(run, 'git', ['status', '--porcelain']).length) {
    throw new Error('Commit or stash all tracked and untracked changes before releasing.')
  }
}

export function requireCurrentMain(run) {
  if (checked(run, 'git', ['branch', '--show-current']) !== 'main') {
    throw new Error('Releases must start on main. Run: git switch main')
  }
  requireCleanTree(run)
  const commit = checked(run, 'git', ['rev-parse', 'HEAD'])
  requireRemoteMain(run, commit)
  return commit
}

export function requireRemoteMain(run, commit) {
  checked(run, 'git', ['fetch', 'origin', 'refs/heads/main:refs/remotes/origin/main'])
  if (checked(run, 'git', ['rev-parse', 'origin/main']) !== commit) {
    throw new Error('Local release base differs from origin/main. Update main with git pull --ff-only and retry.')
  }
}

export function requireGitHub(run, repository) {
  const url = checked(run, 'git', ['remote', 'get-url', '--push', 'origin'])
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+?)(?:\.git)?$/u.exec(url)
  if (match?.[1] !== repository) throw new Error(`origin must push to github.com/${repository}.`)
  checked(run, 'gh', ['auth', 'status'])
}

export function createReleaseBranch(run, branch) {
  const local = run('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])
  if (local.status === 0) {
    throw new Error(`Local release branch ${branch} already exists. Inspect git log main..${branch}; preserve any work, then run git switch main and git branch -d ${branch} before retrying.`)
  }
  if (local.status !== 1) throw new Error(`Cannot inspect local branch ${branch}: ${local.stderr}`)
  if (checked(run, 'git', ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`])) {
    throw new Error(`Release branch ${branch} already exists on origin. Inspect: gh pr list --head ${branch}`)
  }
  checked(run, 'git', ['switch', '-c', branch])
}

export function removeUncommittedReleaseBranch(run, branch, base) {
  if (checked(run, 'git', ['branch', '--show-current']) !== branch
      || checked(run, 'git', ['rev-parse', 'HEAD']) !== base
      || checked(run, 'git', ['rev-parse', 'refs/heads/main']) !== base
      || checked(run, 'git', ['status', '--porcelain'])) {
    return false
  }
  checked(run, 'git', ['switch', 'main'])
  checked(run, 'git', ['branch', '-d', branch])
  return true
}

export function tagState(run, tag) {
  const local = run('git', ['show-ref', '--verify', '--quiet', `refs/tags/${tag}`])
  if (![0, 1].includes(local.status)) throw new Error(`Cannot inspect local tag ${tag}: ${local.stderr}`)
  const localCommit = local.status === 0
    ? checked(run, 'git', ['rev-parse', `refs/tags/${tag}^{}`])
    : null
  const remote = checked(run, 'git', ['ls-remote', '--tags', 'origin', `refs/tags/${tag}`, `refs/tags/${tag}^{}`])
    .split('\n').filter(Boolean).map(line => line.split(/\s+/u))
  const remoteCommit = (remote.find(([, ref]) => ref.endsWith('^{}')) ?? remote[0])?.[0] ?? null
  const localObject = local.status === 0 ? checked(run, 'git', ['rev-parse', `refs/tags/${tag}`]) : null
  const remoteObject = remote.find(([, ref]) => ref === `refs/tags/${tag}`)?.[0] ?? null
  if (localObject && remoteObject && localObject !== remoteObject) {
    throw new Error(`Local and remote ${tag} tags differ; inspect them before retrying.`)
  }
  return { localCommit, remoteCommit }
}

function npmErrorCodes(output) {
  if (output.trimStart().startsWith('{')) {
    try {
      const response = JSON.parse(output)
      return [typeof response.error?.code === 'string' ? response.error.code : null]
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error
      return [null]
    }
  }
  return [...output.matchAll(/^npm (?:error|ERR!) code (\S+)\s*$/gmu)].map(([, code]) => code)
}

export function npmVersion(run, name, version) {
  const result = run('npm', ['view', `${name}@${version}`, '--json', '--registry', registry])
  if (result.status !== 0) {
    const codes = [result.stdout, result.stderr].flatMap(npmErrorCodes)
    if (codes.length && codes.every(code => code === 'E404')) return null
    throw new Error(`Cannot query npm for ${name}@${version}: ${[result.stdout, result.stderr].filter(Boolean).join('\n')}`)
  }
  const parsed = JSON.parse(result.stdout)
  const manifest = Array.isArray(parsed) ? (parsed.length === 1 ? parsed[0] : null) : parsed
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)
      || manifest.name !== name || manifest.version !== version
      || typeof manifest.dist?.integrity !== 'string' || !manifest.dist.integrity) {
    throw new Error(`Unexpected npm metadata for ${name}@${version}.`)
  }
  return manifest
}

export function githubRelease(run, repository, tag) {
  const result = run('gh', ['api', '--include', `repos/${repository}/releases/tags/${tag}`])
  const status = /^HTTP\/[\d.]+ (\d+)/mu.exec(result.stdout)?.[1]
  if (status === '404') return null
  if (result.status !== 0 || status !== '200') {
    throw new Error(`Cannot query GitHub Release ${tag}: ${result.stderr || result.stdout}`)
  }
  return JSON.parse(result.stdout.slice(result.stdout.indexOf('{')))
}

export function publishPlan({ commit, tag, packages, published, release, resume }) {
  const exists = tag.localCommit || tag.remoteCommit
  if (!resume && (exists || published.some(Boolean) || release)) {
    throw new Error('Tag, npm version or GitHub Release already exists. Inspect it, then use pnpm release:publish --resume.')
  }
  if ((tag.localCommit && tag.localCommit !== commit) || (tag.remoteCommit && tag.remoteCommit !== commit)) {
    throw new Error('Existing release tag does not point to the checked main commit.')
  }
  if ((published.some(Boolean) || release) && !tag.remoteCommit) {
    throw new Error('Published release state has no matching pushed tag; refusing unsafe recovery.')
  }
  if (published.some((value, index) => value && published.slice(0, index).some(previous => !previous))) {
    throw new Error('A dependent package is published without its prerequisite; refusing unsafe recovery.')
  }
  if (release && (published.some(value => !value) || release.draft)) {
    throw new Error('GitHub Release exists before publication completed; inspect the inconsistent release manually.')
  }
  return {
    createTag: !tag.localCommit && !tag.remoteCommit,
    pushTag: !tag.remoteCommit,
    packages: packages.filter((_, index) => !published[index]),
    createRelease: !release
  }
}
