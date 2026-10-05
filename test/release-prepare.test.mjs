import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadChangelogConfig } from 'changelogen'

const state = vi.hoisted(() => ({ fail: '', calls: [] }))
vi.mock('node:child_process', async importOriginal => {
  const original = await importOriginal()
  return {
    ...original,
    execFileSync(command, args, options) {
      if (command !== 'pnpm') return original.execFileSync(command, args, options)
      state.calls.push(args)
      if (state.fail && args.includes(state.fail)) throw new Error('Simulated failure: ' + state.fail)
      if (args[0] === 'install') {
        const cli = JSON.parse(readFileSync(join(options.cwd, 'packages/cli/package.json'), 'utf8'))
        writeFileSync(join(options.cwd, 'pnpm-lock.yaml'), cli.dependencies['better-newsletter'])
      }
    }
  }
})
const { execFileSync } = await vi.importActual('node:child_process')
const { prepareRelease, releaseCommits } = await import('../scripts/release-prepare.mjs')
const directories = []
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
  state.fail = ''
  state.calls = []
})

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'newsletter-release-'))
  directories.push(cwd)
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
  const git = args => execFileSync('git', args, { cwd, stdio: 'pipe' })
  git(['init', '-b', 'release/test'])
  git(['config', 'user.name', 'Release Test'])
  git(['config', 'user.email', 'release@example.com'])
  git(['remote', 'add', 'origin', 'https://github.com/t4sj4n/better-newsletter.git'])
  git(['add', '.'])
  git(['commit', '-m', '🔖 Release 0.1.0-rc.0'])
  git(['tag', 'v0.1.0-rc.0'])
  git(['commit', '--allow-empty', '-m', '✨ Add a capability (#1)'])
  git(['commit', '--allow-empty', '-m', 'Preserve request isolation (#2)'])
  return { cwd, git, read: path => readFileSync(join(cwd, path), 'utf8') }
}

describe('release preparation', () => {
  it('synchronizes only publishable packages and the dependency, writes release notes, and leaves Git/SQL alone', async () => {
    const { cwd, git, read } = fixture()
    writeFileSync(join(cwd, 'CHANGELOG.md'), '# Changelog\n\n## v0.1.0-rc.0\n\nPrevious notes.\n')
    git(['add', 'CHANGELOG.md'])
    git(['commit', '-m', '📝 Preserve previous release notes'])
    const head = git(['rev-parse', 'HEAD']).toString()
    const tags = git(['tag']).toString()
    const sql = read('schema.sql')
    await prepareRelease(cwd, '0.1.0-rc.1')
    expect(JSON.parse(read('packages/better-newsletter/package.json')).version).toBe('0.1.0-rc.1')
    expect(JSON.parse(read('packages/cli/package.json'))).toMatchObject({
      version: '0.1.0-rc.1', dependencies: { 'better-newsletter': 'workspace:0.1.0-rc.1' }
    })
    expect(JSON.parse(read('package.json')).version).toBe('0.0.0')
    expect(read('pnpm-lock.yaml')).toBe('workspace:0.1.0-rc.1')
    expect(read('CHANGELOG.md')).toContain('## v0.1.0-rc.1')
    expect(read('CHANGELOG.md')).toContain('Add a capability')
    expect(read('CHANGELOG.md')).toContain('Preserve request isolation')
    expect(read('CHANGELOG.md')).toContain('Previous notes.')
    expect(read('schema.sql')).toBe(sql)
    expect(git(['rev-parse', 'HEAD']).toString()).toBe(head)
    expect(git(['tag']).toString()).toBe(tags)
    expect(state.calls).toEqual([
      ['--filter', 'better-newsletter', 'build'], ['migration:snapshot:check'],
      ['exec', 'vitest', 'run', 'test/postgres-schema-revision.test.ts'],
      ['install', '--lockfile-only', '--ignore-scripts']
    ])
  })

  it.each(['migration:snapshot:check', 'test/postgres-schema-revision.test.ts', 'install'])(
    'keeps original versions and lockfile when %s fails', async failure => {
      const { cwd, read } = fixture()
      const originals = ['packages/better-newsletter/package.json', 'packages/cli/package.json', 'pnpm-lock.yaml'].map(read)
      state.fail = failure
      await expect(prepareRelease(cwd, '0.1.0-rc.1')).rejects.toThrow('Simulated failure')
      expect(['packages/better-newsletter/package.json', 'packages/cli/package.json', 'pnpm-lock.yaml'].map(read)).toEqual(originals)
    }
  )

  it('rejects main and dirty tracked files before running preparation', async () => {
    const { cwd, git } = fixture()
    git(['branch', '-m', 'main'])
    await expect(prepareRelease(cwd, '0.1.0-rc.1')).rejects.toThrow('dedicated branch')
    git(['branch', '-m', 'release/test'])
    writeFileSync(join(cwd, 'schema.sql'), 'uncommitted target change')
    await expect(prepareRelease(cwd, '0.1.0-rc.1')).rejects.toThrow('tracked changes')
    expect(state.calls).toEqual([])
  })

  it('rejects invalid versions without leaving a partial bump', async () => {
    const { cwd, read } = fixture()
    await expect(prepareRelease(cwd, 'not-a-version')).rejects.toThrow()
    expect(JSON.parse(read('packages/cli/package.json')).version).toBe('0.1.0-rc.0')
    expect(read('pnpm-lock.yaml')).toBe('original lockfile\n')
  })

  it.each(['0.1.0-rc.0', '0.1.0-beta.9'])(
    'rejects release version %s without leaving a partial bump',
    async version => {
      const { cwd, read } = fixture()
      await expect(prepareRelease(cwd, version)).rejects.toThrow('newer than the current version')
      expect(JSON.parse(read('packages/better-newsletter/package.json')).version).toBe('0.1.0-rc.0')
      expect(JSON.parse(read('packages/cli/package.json')).version).toBe('0.1.0-rc.0')
      expect(read('pnpm-lock.yaml')).toBe('original lockfile\n')
    }
  )

  it('preserves Conventional Commits, Gitmoji, breaking changes and plain titles while skipping release commits', async () => {
    const config = await loadChangelogConfig('.', { types: { change: { title: 'Other changes' } } })
    const raw = ['feat: Conventional feature', '🐛 Fix a bug', '💥 Change the API', 'Plain PR title', '🔖 Release 0.1.0-rc.0']
      .map(message => ({ message, body: '', shortHash: 'abcdef', author: { name: 'Test', email: 'test@example.com' } }))
    expect(releaseCommits(raw, config).map(({ type, isBreaking }) => [type, isBreaking])).toEqual([
      ['feat', false], ['fix', false], ['feat', true], ['change', false]
    ])
    const referenced = releaseCommits([{ ...raw[0], message: '✨ Add tokens (#40) (#41)' }], config)[0]
    expect(referenced.references).toContainEqual({ type: 'issue', value: '#40' })
    expect(referenced.references).toContainEqual({ type: 'pull-request', value: '#41' })
  })
})
