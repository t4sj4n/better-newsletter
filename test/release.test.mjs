import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath, URL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { parseReleaseArgs, releaseConfig } from '../scripts/release-cli.mjs'
import { distTag, githubRelease, npmVersion, publishPlan, requireMainCommit, requireSuccessfulCi } from '../scripts/release-core.mjs'
import { releaseCommits } from '../scripts/release-notes.mjs'
import { releaseArtifacts, releaseNotes, releasePackages, repository, requiredCi, requireReleaseCommit } from '../scripts/release-policy.mjs'
import { preparePublication, publishPackages, publicationState } from '../scripts/release-publication.mjs'
import { runReleaseHook } from '../scripts/release-hooks.mjs'

const directories = []
afterEach(() => directories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })))
const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' })
const missing = { status: 1, stdout: '{"error":{"code":"E404"}}', stderr: 'npm error code E404' }
const sha = 'a'.repeat(40)
const version = '0.2.0-beta.1'
const workflow = { id: 246, path: '.github/workflows/ci.yml', state: 'active' }
const ci = overrides => ({ id: 1000, run_number: 1, run_attempt: 1, workflow_id: workflow.id,
  head_sha: sha, head_branch: 'main', event: 'push', status: 'completed', conclusion: 'success', ...overrides })

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'newsletter-release-test-'))
  directories.push(cwd)
  for (const name of ['better-newsletter', 'cli']) {
    const directory = join(cwd, 'packages', name)
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: name === 'cli' ? '@better-newsletter/cli' : name,
      version, ...(name === 'cli' ? { dependencies: { 'better-newsletter': `workspace:${version}` } } : {}) }))
  }
  writeFileSync(join(cwd, 'CHANGELOG.md'), `# Changelog\n\n## v${version}\n\nReviewed notes.\n\n## v0.1.0\n\nOld notes.\n`)
  const packages = releasePackages(cwd)
  const directory = join(cwd, 'artifacts')
  const state = { calls: [], localTag: false, remoteTag: false, published: new Map(), release: null, runs: [ci()], fail: '', packed: 0 }
  const manifest = () => JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'))
  const run = async (command, args, options) => {
    state.calls.push([command, args, options])
    if (command === 'git') {
      if (args[0] === 'rev-parse') return ok(args[1] === '--git-path' ? directory : args[1]?.endsWith('^{}') ? sha : args[1]?.startsWith('refs/tags/') ? 'tag-object' : sha)
      if (args[0] === 'show-ref') return state.localTag ? ok() : { ...ok(), status: 1 }
      if (args[0] === 'ls-remote') return ok(state.remoteTag ? `tag-object\trefs/tags/v${version}\n${sha}\trefs/tags/v${version}^{}` : '')
      if (args[0] === 'cat-file') return ok(args[1] === '-t' ? 'tag' : `Release-Manifest: ${JSON.stringify(manifest())}`)
      if (args[0] === 'show') return ok(JSON.stringify({ version: '0.1.0' }))
      if (args[0] === 'fetch' && args.at(-1).startsWith('refs/tags/')) state.localTag = true
      if (args[0] === 'push') state.remoteTag = true
      return ok()
    }
    if (command === 'gh') {
      if (args[0] === 'api' && args[1] === `repos/${repository}/actions/workflows/ci.yml`) return ok(JSON.stringify(workflow))
      if (args.includes('--paginate')) return ok(JSON.stringify([{ total_count: state.runs.length, workflow_runs: state.runs }]))
      return state.release ? ok(`HTTP/2 200 OK\n\n${JSON.stringify(state.release)}`)
        : { status: 1, stdout: 'HTTP/2 404 Not Found\n\n{"message":"Not Found"}', stderr: '' }
    }
    if (command === 'pnpm') return ok()
    if (command === 'node') {
      state.packed++
      for (const pkg of packages) writeFileSync(join(args[2], `${pkg.name.replace(/^@/u, '').replaceAll('/', '-')}-${version}.tgz`), `packed ${pkg.name}@${version}`)
      state.runs = [ci({ id: 1001, run_number: 2 })]
      return ok()
    }
    if (command === 'npm') {
      if (args[0] === 'view') return state.published.has(args[1]) ? ok(JSON.stringify(state.published.get(args[1]))) : missing
      if (args[0] === 'publish') {
        const artifact = releaseArtifacts(directory, packages).find(item => item.path === args[1])
        if (artifact.name === state.fail) return { status: 9, stdout: '', stderr: 'Simulated registry failure' }
        state.published.set(`${artifact.name}@${version}`, { name: artifact.name, version, dist: { integrity: artifact.integrity } })
        return ok()
      }
    }
    throw new Error(`Unexpected command: ${command} ${args.join(' ')}`)
  }
  return { cwd, directory, packages, state, run }
}

const publishCalls = state => state.calls.filter(([command, args]) => command === 'npm' && args[0] === 'publish')

describe('release package contracts', () => {
  it.each([['0.2.0', 'latest'], ['0.2.0-alpha.1', 'alpha'], ['0.2.0-beta.1', 'beta'], ['0.2.0-rc.1', 'rc']])('uses an explicit channel for %s', (input, channel) => expect(distTag(input)).toBe(channel))
  it('rejects mismatched versions or runtime dependencies', () => {
    const f = fixture()
    const path = join(f.cwd, 'packages/cli/package.json')
    const cli = JSON.parse(readFileSync(path, 'utf8'))
    writeFileSync(path, JSON.stringify({ ...cli, version: '0.3.0' }))
    expect(() => releasePackages(f.cwd)).toThrow('synchronized')
    writeFileSync(path, JSON.stringify({ ...cli, dependencies: { 'better-newsletter': 'workspace:*' } }))
    expect(() => releasePackages(f.cwd)).toThrow('exact synchronized')
  })
  it('reads reviewed notes without requiring the legacy preparation SHA', () => {
    const f = fixture()
    expect(releaseNotes(f.cwd, version)).toContain('Reviewed notes.')
    expect(releaseNotes(f.cwd, version)).not.toContain('Old notes.')
    expect(() => releaseNotes(f.cwd, '0.3.0')).toThrow('must start')
  })
  it('accepts a version bump without exact file-list or parent-SHA requirements', async () => {
    const f = fixture()
    await expect(requireReleaseCommit(f.run, f.packages)).resolves.toBeUndefined()
    await expect(requireReleaseCommit(async () => ok(JSON.stringify({ version })), f.packages)).rejects.toThrow('introduced')
  })
  it('preserves Gitmoji, Conventional Commits and plain squash titles', () => {
    const config = { scopeMap: {}, types: { feat: { title: 'Features' }, fix: { title: 'Fixes' }, change: { title: 'Other changes' } } }
    const commits = ['✨ Add migrations (#10)', 'fix: Repair migration (#11)', 'Keep review wording (#12)', '🔖 Release v0.1.0']
      .map((message, index) => ({ message, body: '', shortHash: String(index), author: { name: '', email: '' } }))
    const parsed = releaseCommits(commits, config)
    expect(parsed.map(commit => commit.type)).toEqual(['feat', 'fix', 'change'])
  })
})

describe('publication and recovery hooks', () => {
  it('accepts a newer green CI run for the same SHA while retaining exact-SHA validation', async () => {
    const f = fixture()
    const result = await preparePublication(f.cwd, { run: f.run })
    expect(result.commit).toBe(sha)
    expect(f.state.packed).toBe(1)
    f.state.runs = [ci({ head_sha: 'b'.repeat(40) })]
    await expect(requireSuccessfulCi(f.run, repository, sha, requiredCi)).rejects.toThrow('No required CI run')
    f.state.runs = [ci(), ci({ id: 1001, run_number: 2, status: 'queued', conclusion: null })]
    await expect(requireSuccessfulCi(f.run, repository, sha, requiredCi)).rejects.toThrow('not completed/success')
  })
  it.each(['better-newsletter', '@better-newsletter/cli'])('stops on failed %s publication and retains artifacts', async name => {
    const f = fixture()
    await preparePublication(f.cwd, { run: f.run })
    f.state.localTag = true
    f.state.fail = name
    await expect(runReleaseHook('publish', version, { cwd: f.cwd, run: f.run })).rejects.toThrow('Publication interrupted')
    expect(publishCalls(f.state)).toHaveLength(name === 'better-newsletter' ? 1 : 2)
    expect(f.state.published.size).toBe(name === 'better-newsletter' ? 0 : 1)
    expect(f.state.calls.filter(([command, args]) => command === 'git' && args[0] === 'push').map(([, args]) => args))
      .toEqual([['push', 'origin', `refs/tags/v${version}`]])
    expect(readFileSync(join(f.directory, 'manifest.json'), 'utf8')).toContain(sha)
  })
  it('resumes only missing packages using cached artifacts, independently of the current main tip', async () => {
    const f = fixture()
    await preparePublication(f.cwd, { run: f.run })
    f.state.localTag = true
    f.state.fail = '@better-newsletter/cli'
    await expect(runReleaseHook('publish', version, { cwd: f.cwd, run: f.run })).rejects.toThrow('Publication interrupted')
    f.state.calls = []
    f.state.fail = ''
    await preparePublication(f.cwd, { run: f.run, resume: true })
    await runReleaseHook('publish', version, { cwd: f.cwd, run: f.run, resume: true })
    expect(f.state.packed).toBe(1)
    expect(publishCalls(f.state)).toHaveLength(1)
    expect(publishCalls(f.state)[0][1][1]).toContain('better-newsletter-cli')
    expect(f.state.calls.some(([command, args]) => command === 'git' && args[0] === 'merge-base' && args.at(-1) === 'origin/main')).toBe(true)
    expect(f.state.calls.some(([command, args]) => command === 'git' && args.join(' ') === 'rev-parse origin/main')).toBe(false)
  })
  it('refuses tampered cache and incompatible published integrity before further publication', async () => {
    const f = fixture()
    await preparePublication(f.cwd, { run: f.run })
    f.state.localTag = true
    f.state.remoteTag = true
    const artifacts = releaseArtifacts(f.directory, f.packages)
    writeFileSync(artifacts[0].path, 'tampered')
    await expect(preparePublication(f.cwd, { run: f.run, resume: true })).rejects.toThrow('Cached release artifacts differ')
    expect(publishCalls(f.state)).toHaveLength(0)
  })
  it('refuses conflicting npm integrity and tag manifests before recovery mutations', async () => {
    const f = fixture()
    await preparePublication(f.cwd, { run: f.run })
    f.state.localTag = true
    f.state.remoteTag = true
    f.state.published.set(`better-newsletter@${version}`, { name: 'better-newsletter', version, dist: { integrity: 'sha512-conflicting' } })
    await expect(preparePublication(f.cwd, { run: f.run, resume: true })).rejects.toThrow('differs from the validated artifact')
    f.state.published.clear()
    const changedTag = (command, args, options) => command === 'git' && args[0] === 'cat-file' && args[1] === '-p'
      ? ok('Release-Manifest: {"commit":"different"}') : f.run(command, args, options)
    await expect(preparePublication(f.cwd, { run: changedTag, resume: true })).rejects.toThrow('tag artifact manifest differs')
    expect(publishCalls(f.state)).toHaveLength(0)
  })
  it('preserves service errors rather than treating them as unpublished versions', async () => {
    const denied = async () => ({ status: 1, stdout: '{"error":{"code":"E401"}}', stderr: 'Authentication failed' })
    await expect(npmVersion(denied, 'better-newsletter', version)).rejects.toThrow('Cannot query npm')
    await expect(githubRelease(async () => ({ status: 1, stdout: 'HTTP/2 403 Forbidden', stderr: 'Access denied' }), repository, `v${version}`))
      .rejects.toThrow('Cannot query GitHub Release')
  })
  it('rejects an unmerged commit and preserves an actual Git ancestry failure', async () => {
    const f = fixture()
    const unmerged = (command, args, options) => args[0] === 'merge-base' ? { ...ok(), status: 1 } : f.run(command, args, options)
    await expect(requireMainCommit(unmerged)).rejects.toThrow('merged into origin/main')
    const failed = (command, args, options) => args[0] === 'merge-base' ? { status: 128, stdout: '', stderr: 'Missing remote reference' } : f.run(command, args, options)
    await expect(requireMainCommit(failed)).rejects.toMatchObject({ exitCode: 128, message: expect.stringContaining('Missing remote reference') })
  })
  it('waits for matching runtime visibility before publishing the CLI', async () => {
    const f = fixture()
    const state = await preparePublication(f.cwd, { run: f.run })
    state.plan.packages = [f.packages[1]]
    await expect(publishPackages(f.run, { ...state, channel: 'beta' })).rejects.toThrow('Matching runtime')
    expect(publishCalls(f.state)).toHaveLength(0)
  })
  it('refuses published versions without the matching tag and CLI without runtime', () => {
    const packages = [{}, {}]
    expect(() => publishPlan({ commit: sha, tag: {}, packages, published: [{}, null], resume: true })).toThrow('matching pushed tag')
    expect(() => publishPlan({ commit: sha, tag: { remoteCommit: sha }, packages, published: [null, {}], resume: true })).toThrow('prerequisite')
  })
  it('keeps a complete existing GitHub Release and publishes nothing on resume', async () => {
    const f = fixture()
    const prepared = await preparePublication(f.cwd, { run: f.run })
    f.state.localTag = true
    f.state.remoteTag = true
    await publishPackages(f.run, { ...prepared, channel: 'beta' })
    f.state.release = { tag_name: `v${version}`, draft: false, prerelease: true }
    f.state.calls = []
    const state = await publicationState(f.run, f.packages, sha, true)
    expect(state.plan).toMatchObject({ createRelease: false, packages: [] })
    const config = releaseConfig('publish', { resume: true }, f.cwd, true)
    expect(config.github.release).toBe(false)
    await runReleaseHook('publish', version, { cwd: f.cwd, run: f.run, resume: true })
    expect(publishCalls(f.state)).toHaveLength(0)
  })
})

describe('native release-it CLI', () => {
  it('rejects removed skip flags and unexpected selectors', () => {
    expect(() => parseReleaseArgs(['--skip-git-checks'], 'prepare')).toThrow('Unknown option')
    expect(() => parseReleaseArgs(['--skip-validation'], 'publish')).toThrow('Unknown option')
    expect(() => parseReleaseArgs(['patch'], 'publish')).toThrow('prepared package version')
    expect(parseReleaseArgs(['prerelease', '--dry-run', '--debug'], 'prepare')).toMatchObject({ increment: 'prerelease', dryRun: true, verbose: true })
  })
  it.each([false, true])('reports native prerequisite failures with stacks only in debug mode (%s)', debug => {
    const f = fixture()
    const script = fileURLToPath(new URL('../scripts/release-prepare.mjs', import.meta.url))
    const result = spawnSync(process.execPath, [script, 'prerelease', ...(debug ? ['--debug'] : [])], { cwd: f.cwd, encoding: 'utf8' })
    expect(result.status).toBe(128)
    expect(result.stderr).toContain('not a git repository')
    expect(result.stderr.includes('at checkedResult')).toBe(debug)
    expect(result.stderr).not.toContain('Node.js v')
  })
  it.each(['prepare', 'publish'])('runs a native %s preview on the dirty development branch without mutations or external-service commands', kind => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' })
    const before = [git(['show-ref']), git(['diff', '--binary']), git(['diff', '--cached', '--binary']), git(['status', '--porcelain'])]
    const shim = mkdtempSync(join(tmpdir(), 'newsletter-preview-test-'))
    directories.push(shim)
    for (const name of ['gh', 'npm', 'pnpm']) writeFileSync(join(shim, name), '#!/bin/sh\necho "Unexpected external service command" >&2\nexit 91\n', { mode: 0o755 })
    const result = spawnSync(process.execPath, [join(root, `scripts/release-${kind}.mjs`), ...(kind === 'prepare' ? ['prerelease'] : []), '--dry-run'],
      { cwd: root, encoding: 'utf8', timeout: 20000, env: { ...process.env, PATH: `${shim}:${process.env.PATH}` } })
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(result.stdout).toContain('Done')
    expect(result.stderr).toContain('Preview only')
    expect(result.stderr).not.toContain('Unexpected external service')
    expect([git(['show-ref']), git(['diff', '--binary']), git(['diff', '--cached', '--binary']), git(['status', '--porcelain'])]).toEqual(before)
  }, 25000)
})
