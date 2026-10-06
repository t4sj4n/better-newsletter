import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadChangelogConfig } from 'changelogen'
import { commandRunner, distTag, githubRelease, nextVersion, npmVersion, publishPlan } from '../scripts/release-core.mjs'
import { prepareRelease, releaseCommits } from '../scripts/release-prepare.mjs'
import { publishRelease } from '../scripts/release-publish.mjs'
import { releaseNotes, releasePackages, releasePaths, validateRelease } from '../scripts/release-policy.mjs'

const directories = []
beforeEach(() => {
  vi.stubEnv('DATABASE_URL', 'postgresql://release-test.invalid/disposable')
})
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'newsletter-release-'))
  directories.push(directory)
  const cwd = join(directory, 'checkout')
  const remote = join(directory, 'origin.git')
  mkdirSync(cwd)
  execFileSync('git', ['init', '--bare', remote], { stdio: 'pipe' })
  for (const name of ['better-newsletter', 'cli']) {
    mkdirSync(join(cwd, 'packages', name), { recursive: true })
    writeFileSync(join(cwd, 'packages', name, 'package.json'), JSON.stringify({
      name: name === 'cli' ? '@better-newsletter/cli' : name,
      version: '0.1.0-rc.0',
      ...(name === 'cli' ? { dependencies: { 'better-newsletter': 'workspace:0.1.0-rc.0' } } : {})
    }, null, 2) + '\n')
  }
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ private: true, version: '0.0.0', type: 'module' }))
  writeFileSync(join(cwd, 'pnpm-lock.yaml'), 'original lockfile\n')
  writeFileSync(join(cwd, 'schema.sql'), '-- Stable target revision: 1\nCREATE TABLE fixture (id text);\n')
  writeFileSync(join(cwd, 'CHANGELOG.md'), '# Changelog\n\n## v0.1.0-rc.0\n\nPrevious notes.\n')
  const git = args => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trimEnd()
  git(['init', '-b', 'main'])
  git(['config', 'user.name', 'Release Test'])
  git(['config', 'user.email', 'release@example.com'])
  git(['remote', 'add', 'origin', remote])
  git(['add', '.'])
  git(['commit', '-m', '🔖 Release 0.1.0-rc.0'])
  git(['tag', 'v0.1.0-rc.0'])
  git(['commit', '--allow-empty', '-m', '✨ Add a capability (#1)'])
  git(['commit', '--allow-empty', '-m', 'Preserve request isolation (#2)'])
  git(['push', '-u', 'origin', 'main'])
  const read = path => readFileSync(join(cwd, path), 'utf8')
  const state = {
    calls: [], fail: '', published: new Map(), release: null,
    missingVersionResponse: { status: 1, stdout: '{"error":{"code":"E404"}}', stderr: 'npm error code E404\n' }
  }
  const real = commandRunner(cwd)
  const ok = stdout => ({ status: 0, stdout: stdout ?? '', stderr: '' })
  const run = (command, args, options) => {
    state.calls.push([command, args, options])
    if (state.fail && [command, ...args].includes(state.fail)) {
      return { status: 1, stdout: '', stderr: `Simulated failure: ${state.fail}` }
    }
    if (command === 'git') {
      if (args[0] === 'remote' && args[1] === 'get-url') return ok('https://github.com/t4sj4n/better-newsletter.git')
      return real(command, args, options)
    }
    if (command === 'pnpm') {
      if (args[0] === 'install') {
        const cli = JSON.parse(read('packages/cli/package.json'))
        writeFileSync(join(cwd, 'pnpm-lock.yaml'), cli.dependencies['better-newsletter'])
      }
      return ok()
    }
    if (command === 'node' && args[0] === 'scripts/smoke-pack.mjs') {
      if (args[1] === '--pack-destination') {
        for (const pkg of releasePackages(cwd)) {
          writeFileSync(join(args[2], tarball(pkg)), `packed ${pkg.name}@${pkg.version}`)
        }
      }
      return ok()
    }
    if (command === 'npm') {
      if (args[0] === 'whoami') return ok('release-test')
      if (args[0] === 'view') {
        const existing = state.published.get(args[1])
        return existing ? ok(JSON.stringify(existing)) : state.missingVersionResponse
      }
      if (args[0] === 'publish') {
        const pkg = releasePackages(cwd).find(pkg => args[1].endsWith(tarball(pkg)))
        state.published.set(`${pkg.name}@${pkg.version}`, {
          name: pkg.name, version: pkg.version,
          dist: { integrity: `sha512-${createHash('sha512').update(readFileSync(args[1])).digest('base64')}` }
        })
        return ok()
      }
    }
    if (command === 'gh') {
      if (args[0] === 'auth') return ok()
      if (args[0] === 'pr') return ok('https://github.com/t4sj4n/better-newsletter/pull/100')
      if (args[0] === 'api') {
        return state.release ? ok(`HTTP/2 200 OK\n\n${JSON.stringify(state.release)}`)
          : { status: 1, stdout: 'HTTP/2 404 Not Found\n\n{"message":"Not Found"}', stderr: '' }
      }
      if (args[0] === 'release' && args[1] === 'create') {
        state.release = { tag_name: args[2], prerelease: args.includes('--prerelease'), draft: false }
        return ok()
      }
    }
    throw new Error(`Unexpected test command: ${command} ${args.join(' ')}`)
  }
  function prepareCommit(version = '0.1.0-rc.1', base = git(['rev-parse', 'HEAD'])) {
    const packages = releasePackages(cwd)
    for (const pkg of packages) {
      pkg.version = version
      if (pkg.dependencies) pkg.dependencies['better-newsletter'] = `workspace:${version}`
      const { path, ...manifest } = pkg
      writeFileSync(join(cwd, path), JSON.stringify(manifest, null, 2) + '\n')
    }
    writeFileSync(join(cwd, 'pnpm-lock.yaml'), `workspace:${version}`)
    writeFileSync(join(cwd, 'CHANGELOG.md'), `# Changelog\n\n## v${version}\n\n<!-- release-base: ${base} -->\n\nRelease notes.\n\n## v0.1.0-rc.0\n\nOld notes.\n`)
    git(['add', '.'])
    git(['commit', '-m', `🔖 Release v${version}`])
    git(['push', 'origin', 'main'])
  }
  return { cwd, git, read, run, state, prepareCommit }
}

function tarball(pkg) {
  return `${pkg.name.replace(/^@/u, '').replaceAll('/', '-')}-${pkg.version}.tgz`
}

function mutations(state) {
  return state.calls.filter(([command, args]) =>
    (command === 'git' && ['tag', 'push'].includes(args[0]))
    || (command === 'npm' && args[0] === 'publish')
    || (command === 'gh' && args[0] === 'release' && args[1] === 'create'))
}

describe('release version selection', () => {
  it.each([
    ['0.1.0-beta.1', 'prerelease', '0.1.0-beta.2'],
    ['1.2.3', 'patch', '1.2.4'],
    ['1.2.3', 'minor', '1.3.0'],
    ['1.2.3', 'major', '2.0.0'],
    ['0.1.0-beta.1', 'patch', '0.1.0'],
    ['0.1.0-beta.1', '0.2.0-beta.1', '0.2.0-beta.1']
  ])('%s + %s = %s', (current, selector, expected) => {
    expect(nextVersion(current, selector)).toBe(expected)
  })
  it.each(['not-a-version', '0.1.0-beta.0', '0.1.0-beta.1', 'v0.2.0', '0.2.0+build', '0.2.0-dev.1'])(
    'rejects invalid, equal, downgrade or unsupported %s', selector => {
      expect(() => nextVersion('0.1.0-beta.1', selector)).toThrow()
    }
  )
  it('requires an explicit channel when entering prerelease from stable', () => {
    expect(() => nextVersion('1.0.0', 'prerelease')).toThrow('existing prerelease')
  })
  it.each([['1.0.0-alpha.1', 'alpha'], ['1.0.0-beta.2', 'beta'], ['1.0.0-rc.1', 'rc'], ['1.0.0', 'latest']])(
    'maps %s explicitly to %s', (version, tag) => expect(distTag(version)).toBe(tag)
  )
})

describe('release preparation', () => {
  it('prepares, validates, commits, pushes and opens a draft PR without tagging or publishing', async () => {
    const { cwd, git, read, run, state } = fixture()
    const base = git(['rev-parse', 'HEAD'])
    const sql = read('schema.sql')
    const tags = git(['tag'])
    await prepareRelease(cwd, 'prerelease', { run })
    expect(releasePackages(cwd).map(pkg => pkg.version)).toEqual(['0.1.0-rc.1', '0.1.0-rc.1'])
    expect(JSON.parse(read('package.json')).version).toBe('0.0.0')
    expect(read('pnpm-lock.yaml')).toBe('workspace:0.1.0-rc.1')
    expect(read('CHANGELOG.md')).toContain('## v0.1.0-rc.1')
    expect(read('CHANGELOG.md')).toContain(`<!-- release-base: ${base} -->`)
    expect(releaseNotes(cwd, '0.1.0-rc.1')).not.toContain('release-base:')
    expect(read('CHANGELOG.md')).toContain('Add a capability')
    expect(read('CHANGELOG.md')).toContain('Preserve request isolation')
    expect(read('CHANGELOG.md')).toContain('Previous notes.')
    expect(read('schema.sql')).toBe(sql)
    expect(git(['tag'])).toBe(tags)
    expect(git(['branch', '--show-current'])).toBe('release/v0.1.0-rc.1')
    expect(git(['status', '--porcelain'])).toBe('')
    expect(git(['log', '-1', '--format=%s'])).toBe('🔖 Release v0.1.0-rc.1')
    expect(state.calls.filter(([command]) => command === 'pnpm').map(([, args]) => args)).toEqual([
      ['--filter', 'better-newsletter', 'build'], ['migration:snapshot:check'],
      ['exec', 'vitest', 'run', 'test/postgres-schema-revision.test.ts'],
      ['install', '--lockfile-only', '--ignore-scripts'], ['check']
    ])
    expect(state.calls.some(([command, args]) => command === 'node' && args[0] === 'scripts/smoke-pack.mjs')).toBe(true)
    expect(state.calls.find(([command, args]) => command === 'gh' && args[0] === 'pr')[1]).toContain('--draft')
    expect(mutations(state).map(([command, args]) => [command, args[0]])).toEqual([['git', 'push']])
  })

  it('retains interactive selection without changing files or creating a branch before selection', async () => {
    const { cwd, git, read, run } = fixture()
    const originals = releasePaths.map(read)
    const selectVersion = vi.fn(async () => {
      expect(git(['branch', '--show-current'])).toBe('main')
      expect(releasePaths.map(read)).toEqual(originals)
      return { results: { newVersion: '0.1.0-rc.1' } }
    })
    await prepareRelease(cwd, undefined, { run, selectVersion })
    expect(selectVersion).toHaveBeenCalledWith(expect.objectContaining({ preid: 'rc', release: 'prompt' }))
    expect(releasePackages(cwd)[0].version).toBe('0.1.0-rc.1')
  })

  it('leaves files and branch unchanged when interactive selection is cancelled', async () => {
    const { cwd, git, read, run, state } = fixture()
    const originals = releasePaths.map(read)
    const selectVersion = async () => { throw new Error('Selection cancelled') }
    await expect(prepareRelease(cwd, undefined, { run, selectVersion })).rejects.toThrow('cancelled')
    expect(releasePaths.map(read)).toEqual(originals)
    expect(git(['branch', '--show-current'])).toBe('main')
    expect(mutations(state)).toEqual([])
  })

  it('rejects an existing remote release branch without changing versions', async () => {
    const { cwd, git, read, run, state } = fixture()
    const originals = releasePaths.map(read)
    git(['push', 'origin', 'HEAD:refs/heads/release/v0.1.0-rc.1'])
    await expect(prepareRelease(cwd, 'prerelease', { run })).rejects.toThrow('already exists on origin')
    expect(releasePaths.map(read)).toEqual(originals)
    expect(git(['branch', '--show-current'])).toBe('main')
    expect(mutations(state)).toEqual([])
  })

  it.each(['migration:snapshot:check', 'test/postgres-schema-revision.test.ts', 'install', 'check', 'scripts/smoke-pack.mjs'])(
    'keeps original release files when %s fails', async failure => {
      const { cwd, read, run, state } = fixture()
      const originals = releasePaths.map(read)
      state.fail = failure
      await expect(prepareRelease(cwd, '0.1.0-rc.1', { run })).rejects.toThrow()
      expect(releasePaths.map(read)).toEqual(originals)
      expect(mutations(state)).toEqual([])
    }
  )

  it.each(['wrong branch', 'dirty tracked', 'dirty untracked', 'stale main'])(
    'rejects %s before preparation', async condition => {
      const { cwd, git, run, state } = fixture()
      if (condition === 'wrong branch') git(['switch', '-c', 'feature/test'])
      if (condition === 'dirty tracked') writeFileSync(join(cwd, 'schema.sql'), 'uncommitted change')
      if (condition === 'dirty untracked') writeFileSync(join(cwd, 'new-file'), 'untracked')
      if (condition === 'stale main') git(['commit', '--allow-empty', '-m', 'Local-only commit'])
      await expect(prepareRelease(cwd, '0.1.0-rc.1', { run })).rejects.toThrow()
      expect(state.calls.some(([command]) => command === 'pnpm')).toBe(false)
      expect(mutations(state)).toEqual([])
    }
  )

  it.each(['version', 'dependency'])('rejects mismatched CLI %s', async field => {
    const { cwd, git, read, run } = fixture()
    const cli = JSON.parse(read('packages/cli/package.json'))
    if (field === 'version') cli.version = '0.1.0-rc.1'
    else cli.dependencies['better-newsletter'] = 'workspace:^0.1.0-rc.0'
    writeFileSync(join(cwd, 'packages/cli/package.json'), JSON.stringify(cli))
    git(['add', '.'])
    git(['commit', '-m', 'Invalid synchronization'])
    git(['push', 'origin', 'main'])
    await expect(prepareRelease(cwd, '0.1.0-rc.2', { run })).rejects.toThrow(
      field === 'version' ? 'versions must be synchronized' : 'exact synchronized runtime'
    )
  })

  it.each(['push', 'pr'])('preserves the prepared commit with actionable recovery when %s fails', async failure => {
    const { cwd, git, run, state } = fixture()
    state.fail = failure
    await expect(prepareRelease(cwd, 'prerelease', { run })).rejects.toThrow(
      failure === 'push' ? 'git push -u origin release/v0.1.0-rc.1' : 'gh pr create --draft'
    )
    expect(git(['log', '-1', '--format=%s'])).toBe('🔖 Release v0.1.0-rc.1')
    expect(git(['status', '--porcelain'])).toBe('')
  })

  it('preserves Conventional Commits, Gitmoji, breaking changes and plain titles while skipping release commits', async () => {
    const config = await loadChangelogConfig('.', { types: { change: { title: 'Other changes' } } })
    const raw = ['feat: Conventional feature', '🐛 Fix a bug', '💥 Change the API', 'Plain PR title',
      '🔖 Release 0.1.0-rc.0', 'chore(release): v0.1.0-rc.0']
      .map(message => ({ message, body: '', shortHash: 'abcdef', author: { name: 'Test', email: 'test@example.com' } }))
    expect(releaseCommits(raw, config).map(({ type, isBreaking }) => [type, isBreaking])).toEqual([
      ['feat', false], ['fix', false], ['feat', true], ['change', false]
    ])
    const referenced = releaseCommits([{ ...raw[0], message: '✨ Add tokens (#40) (#41)' }], config)[0]
    expect(referenced.references).toContainEqual({ type: 'issue', value: '#40' })
    expect(referenced.references).toContainEqual({ type: 'pull-request', value: '#41' })
  })
})

describe('release publication', () => {
  it.each(['0.1.0-rc.1', '0.1.0'])('validates before mutations and publishes %s runtime before CLI', version => {
    const { cwd, git, run, state, prepareCommit } = fixture()
    prepareCommit(version)
    const head = git(['rev-parse', 'HEAD'])
    publishRelease(cwd, { run })
    const actions = mutations(state)
    expect(actions.map(([command, args]) => [command, args[0]])).toEqual([
      ['git', 'tag'], ['git', 'push'], ['npm', 'publish'], ['npm', 'publish'], ['gh', 'release']
    ])
    expect(actions[2][1][1]).toContain(`/better-newsletter-${version}.tgz`)
    expect(actions[3][1][1]).toContain(`/better-newsletter-cli-${version}.tgz`)
    expect(actions[2][1]).toContain(version.includes('-') ? 'rc' : 'latest')
    expect(state.calls.findIndex(([command, args]) => command === 'node' && args[0] === 'scripts/smoke-pack.mjs'))
      .toBeLessThan(state.calls.indexOf(actions[0]))
    expect(git(['rev-parse', `v${version}^{}`])).toBe(head)
    expect(git(['cat-file', '-p', `v${version}`])).toContain('Release-Manifest:')
    expect(actions[4][2].input).toContain('Release notes.')
    expect(actions[4][2].input).not.toContain('release-base:')
    expect(state.release.prerelease).toBe(version.includes('-'))
    expect(() => publishRelease(cwd, { run })).toThrow('already exists')
    state.calls = []
    publishRelease(cwd, { run, resume: true })
    expect(mutations(state)).toEqual([])
  })

  it.each([
    '{"error":{"code":"E404"}}',
    'npm error code E404\nnpm error 404 No match found for version 0.1.0-rc.1\n'
  ])('prepares and publishes when npm reports missing versions only on stderr: %s', async stderr => {
    const { cwd, git, run, state } = fixture()
    state.missingVersionResponse = { status: 1, stdout: '', stderr }
    await prepareRelease(cwd, 'prerelease', { run })
    git(['switch', 'main'])
    git(['merge', '--squash', 'release/v0.1.0-rc.1'])
    git(['commit', '-m', '🔖 Release v0.1.0-rc.1'])
    git(['push', 'origin', 'main'])
    state.calls = []
    publishRelease(cwd, { run })
    expect(state.published.size).toBe(2)
    expect(state.release.tag_name).toBe('v0.1.0-rc.1')
  })

  it('rejects an intervening feature and permits a regenerated corrective release', async () => {
    const { cwd, git, read, run, state } = fixture()
    const base = git(['rev-parse', 'HEAD'])
    await prepareRelease(cwd, 'prerelease', { run })
    git(['switch', 'main'])
    writeFileSync(join(cwd, 'feature-b.txt'), 'Feature B landed after release preparation.\n')
    git(['add', 'feature-b.txt'])
    git(['commit', '-m', '✨ Add feature B'])
    git(['push', 'origin', 'main'])
    git(['merge', '--squash', 'release/v0.1.0-rc.1'])
    git(['commit', '-m', '🔖 Release v0.1.0-rc.1'])
    git(['push', 'origin', 'main'])
    expect(git(['rev-parse', 'HEAD^'])).not.toBe(base)
    expect(read('CHANGELOG.md')).toContain(`<!-- release-base: ${base} -->`)
    expect(read('CHANGELOG.md')).not.toContain('Add feature B')
    state.calls = []
    expect(() => publishRelease(cwd, { run })).toThrow('main advanced before the release merge')
    expect(() => publishRelease(cwd, { run, resume: true })).toThrow('main advanced before the release merge')
    expect(mutations(state)).toEqual([])
    expect(state.calls.some(([command]) => ['npm', 'gh', 'pnpm', 'node'].includes(command))).toBe(false)
    const correctedBase = git(['rev-parse', 'HEAD'])
    await prepareRelease(cwd, 'prerelease', { run })
    expect(releaseNotes(cwd, '0.1.0-rc.2')).toContain('Add feature B')
    expect(read('CHANGELOG.md')).toContain(`<!-- release-base: ${correctedBase} -->`)
    git(['switch', 'main'])
    git(['merge', '--squash', 'release/v0.1.0-rc.2'])
    git(['commit', '-m', '🔖 Release v0.1.0-rc.2'])
    git(['push', 'origin', 'main'])
    publishRelease(cwd, { run })
    expect(state.release.tag_name).toBe('v0.1.0-rc.2')
  })

  it.each(['wrong branch', 'dirty tracked', 'dirty untracked', 'stale main', 'later commit'])(
    'rejects %s before irreversible publication', condition => {
      const { cwd, git, run, state, prepareCommit } = fixture()
      prepareCommit()
      if (condition === 'wrong branch') git(['switch', '-c', 'release/test'])
      if (condition === 'dirty tracked') writeFileSync(join(cwd, 'schema.sql'), 'changed')
      if (condition === 'dirty untracked') writeFileSync(join(cwd, 'new-file'), 'untracked')
      if (condition === 'stale main' || condition === 'later commit') git(['commit', '--allow-empty', '-m', 'Later commit'])
      if (condition === 'later commit') git(['push', 'origin', 'main'])
      expect(() => publishRelease(cwd, { run })).toThrow()
      expect(mutations(state)).toEqual([])
    }
  )

  it.each(['local tag', 'remote tag', 'npm version', 'check', 'scripts/smoke-pack.mjs'])(
    'rejects %s before mutations', condition => {
      const { cwd, git, run, state, prepareCommit } = fixture()
      prepareCommit()
      if (condition.includes('tag')) {
        git(['tag', 'v0.1.0-rc.1'])
        if (condition === 'remote tag') {
          git(['push', 'origin', 'v0.1.0-rc.1'])
          git(['tag', '-d', 'v0.1.0-rc.1'])
        }
      } else if (condition === 'npm version') {
        state.published.set('better-newsletter@0.1.0-rc.1', {
          name: 'better-newsletter', version: '0.1.0-rc.1', dist: { integrity: 'sha512-existing' }
        })
      } else state.fail = condition
      expect(() => publishRelease(cwd, { run })).toThrow()
      expect(mutations(state)).toEqual([])
    }
  )

  it.each(['tag push', 'runtime publish', 'CLI publish', 'GitHub Release'])(
    'safely resumes after failed %s without repeating completed mutations', failure => {
      const { cwd, git, run, state, prepareCommit } = fixture()
      prepareCommit()
      let failed = false
      const flaky = (command, args, options) => {
        const selected = failure === 'tag push' ? command === 'git' && args[0] === 'push'
          : failure === 'runtime publish' ? command === 'npm' && args[0] === 'publish' && args[1].includes('/better-newsletter-0.')
            : failure === 'CLI publish' ? command === 'npm' && args[0] === 'publish' && args[1].includes('/better-newsletter-cli-')
              : command === 'gh' && args[0] === 'release' && args[1] === 'create'
        if (selected && !failed) {
          failed = true
          return { status: 1, stdout: '', stderr: 'External service failed' }
        }
        return run(command, args, options)
      }
      expect(() => publishRelease(cwd, { run: flaky })).toThrow('pnpm release:publish --resume')
      expect(git(['tag'])).toContain('v0.1.0-rc.1')
      const alreadyPublished = state.published.size
      state.calls = []
      if (failure === 'GitHub Release') {
        git(['tag', '-d', 'v0.1.0-rc.1'])
      }
      publishRelease(cwd, { run, resume: true })
      expect(state.published.size).toBe(2)
      expect(mutations(state).filter(([command]) => command === 'npm')).toHaveLength(2 - alreadyPublished)
      expect(mutations(state).filter(([command, args]) => command === 'git' && args[0] === 'tag')).toHaveLength(0)
      expect(state.release.tag_name).toBe('v0.1.0-rc.1')
    }
  )

  it('rejects mismatched tag artifacts and published integrity during recovery', () => {
    const { cwd, run, state, prepareCommit } = fixture()
    prepareCommit()
    state.fail = 'publish'
    expect(() => publishRelease(cwd, { run })).toThrow('interrupted')
    state.fail = ''
    const tampered = (command, args, options) => {
      const result = run(command, args, options)
      if (command === 'node' && args[1] === '--pack-destination') {
        writeFileSync(join(args[2], 'better-newsletter-0.1.0-rc.1.tgz'), 'different artifact')
      }
      return result
    }
    expect(() => publishRelease(cwd, { run: tampered, resume: true })).toThrow('artifact manifest differs')
    state.published.set('better-newsletter@0.1.0-rc.1', {
      name: 'better-newsletter', version: '0.1.0-rc.1', dist: { integrity: 'sha512-different' }
    })
    expect(() => publishRelease(cwd, { run, resume: true })).toThrow('differs from the validated artifact')
  })

  it('will not publish the CLI until the runtime is visible on npm', () => {
    const { cwd, run, state, prepareCommit } = fixture()
    prepareCommit()
    const delayed = (command, args, options) => {
      const result = run(command, args, options)
      if (command === 'npm' && args[0] === 'publish') state.published.clear()
      return result
    }
    expect(() => publishRelease(cwd, { run: delayed })).toThrow('interrupted')
    expect(mutations(state).filter(([command]) => command === 'npm')).toHaveLength(1)
    expect(state.release).toBeNull()
  })

  it('rechecks external state after validation and before creating a tag', () => {
    const { cwd, run, state, prepareCommit } = fixture()
    prepareCommit()
    const raced = (command, args, options) => {
      const result = run(command, args, options)
      if (command === 'node' && args[1] === '--pack-destination') {
        state.published.set('better-newsletter@0.1.0-rc.1', {
          name: 'better-newsletter', version: '0.1.0-rc.1', dist: { integrity: 'sha512-concurrent-release' }
        })
      }
      return result
    }
    expect(() => publishRelease(cwd, { run: raced })).toThrow('External release state changed')
    expect(mutations(state)).toEqual([])
  })
})

describe('external-state safety', () => {
  it.each(['missing', 'invalid', 'duplicate'])('rejects %s release-base metadata', condition => {
    const { cwd, read, prepareCommit } = fixture()
    prepareCommit()
    const marker = /^<!-- release-base: .* -->$/mu
    const changelog = read('CHANGELOG.md').replace(marker, comment =>
      condition === 'missing' ? ''
        : condition === 'invalid' ? '<!-- release-base: invalid-sha -->'
          : `${comment}\n${comment}`)
    writeFileSync(join(cwd, 'CHANGELOG.md'), changelog)
    expect(() => releaseNotes(cwd, '0.1.0-rc.1')).toThrow('exactly one valid release-base SHA')
  })

  it('preserves reviewed notes and ignores previous releases when reading the current base marker', () => {
    const { cwd, read, prepareCommit } = fixture()
    prepareCommit()
    const changelog = read('CHANGELOG.md')
      .replace('Release notes.', 'Manually reviewed release notes.')
      .replace('Old notes.', `<!-- release-base: ${'a'.repeat(40)} -->\n\nOld notes.`)
    writeFileSync(join(cwd, 'CHANGELOG.md'), changelog)
    expect(releaseNotes(cwd, '0.1.0-rc.1')).toBe('## v0.1.0-rc.1\n\nManually reviewed release notes.\n')
  })

  it('requires a database for complete release validation instead of skipping database checks', () => {
    vi.stubEnv('DATABASE_URL', '')
    const run = vi.fn()
    expect(() => validateRelease(run)).toThrow('Set DATABASE_URL')
    expect(run).not.toHaveBeenCalled()
  })
  it.each([
    ['{"error":{"code":"E404"}}', ''],
    ['', '{"error":{"code":"E404"}}'],
    ['', 'npm error code E404\nnpm error 404 No match found for version 1.0.0\n'],
    ['', 'npm ERR! code E404\nnpm ERR! 404 No match found for version 1.0.0\n'],
    ['{"error":{"code":"E404"}}', 'npm error code E404\n']
  ])('recognizes an explicit npm E404 across stdout/stderr', (stdout, stderr) => {
    expect(npmVersion(() => ({ status: 1, stdout, stderr }), 'pkg', '1.0.0')).toBeNull()
  })

  it.each([
    ['{"error":{"code":"E401"}}', ''],
    ['', '{"error":{"code":"E403"}}'],
    ['', 'npm error code ECONNRESET\n'],
    ['', 'network timeout'],
    ['', 'network failure while requesting /E404'],
    ['{"error":{"code":"E401"}}', 'npm error code E404\n'],
    ['{"error":{"code":"E404"}}', 'npm ERR! code E401\n'],
    ['{}', 'npm error code E404\n'],
    ['{"error":', 'npm error code E404\n']
  ])('does not turn authentication/network/conflicting errors into an unpublished version', (stdout, stderr) => {
    expect(() => npmVersion(() => ({ status: 1, stdout, stderr }), 'pkg', '1.0.0')).toThrow('Cannot query npm')
  })

  it('does not treat GitHub authentication failures as an absent release', () => {
    expect(() => githubRelease(() => ({ status: 1, stdout: 'HTTP/2 401 Unauthorized', stderr: 'Bad credentials' }),
      'owner/repo', 'v1.0.0')).toThrow('Bad credentials')
  })

  it.each(['wrong tag', 'missing tag', 'CLI without runtime', 'release without packages'])(
    'refuses inconsistent recovery: %s', condition => {
      const tag = { localCommit: 'abc', remoteCommit: 'abc' }
      let published = [null, null]
      let release = null
      if (condition === 'wrong tag') tag.remoteCommit = 'other'
      if (condition === 'missing tag') {
        tag.remoteCommit = null
        published = [{}, null]
      }
      if (condition === 'CLI without runtime') published = [null, {}]
      if (condition === 'release without packages') release = { draft: false }
      expect(() => publishPlan({ commit: 'abc', tag, packages: [{}, {}], published, release, resume: true })).toThrow()
    }
  )
})
