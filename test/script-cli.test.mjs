import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { PassThrough, Writable } from 'node:stream'
import { fileURLToPath, URL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { select } from '@clack/prompts'
import { dryRunFlags, parseScriptArgs, runScriptCli, validateScriptOptions } from '../scripts/script-cli.mjs'
import { checked, runScriptChecks } from '../scripts/script-core.mjs'
import { createScriptUi, ScriptCancelled } from '../scripts/script-ui.mjs'

const directories = []
afterEach(() => {
  directories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true }))
  vi.unstubAllEnvs()
})

function temp() {
  const directory = mkdtempSync(join(tmpdir(), 'newsletter-script-test-'))
  directories.push(directory)
  return directory
}

describe('shared script CLI', () => {
  it('supports script-specific flags and selectors without accepting release options implicitly', () => {
    expect(parseScriptArgs(['--write', '--debug', 'snapshot'], { flags: { '--write': 'write' }, maxPositionals: 1 }))
      .toEqual({ options: { verbose: true, write: true }, positionals: ['snapshot'] })
    expect(() => parseScriptArgs(['--dry-run'])).toThrow('Unexpected script arguments')
    expect(() => parseScriptArgs(['--skip-git-checks'], { flags: dryRunFlags, validate: validateScriptOptions }))
      .toThrow('--skip-git-checks requires --dry-run')
  })

  it('renders another script with the same summary and measures cancelled prompt waits', async () => {
    let output = ''
    let clock = 0
    const ui = createScriptUi({ name: 'example-tool', now: () => clock,
      output: new Writable({ write(chunk, encoding, callback) { output += chunk; callback() } }) })
    ui.start('snapshot verification')
    await ui.step('Reading snapshot', async () => { clock += 200 })
    const controller = new globalThis.AbortController()
    const selection = select({ message: 'Choose a snapshot', options: [{ value: 'current', label: 'Current' }],
      signal: controller.signal, input: new PassThrough(), output: new Writable({ write(chunk, encoding, callback) { callback() } }) })
    controller.abort()
    const cancelled = await selection
    await expect(ui.input(async () => { clock += 1500; return cancelled })).rejects.toBeInstanceOf(ScriptCancelled)
    ui.cancel('Verification cancelled.')
    expect(output).toContain('example-tool · snapshot verification')
    expect(output).toContain('Reading snapshot (200ms)')
    expect(output).toContain('Prompt wait    1.5s (1 prompt)')
    expect(output).toContain('Run summary')
    expect(output).not.toMatch(/better-newsletter|Release/u)
  })

  it('preserves the root command exit code and uses generic failure output', async () => {
    const ui = Object.fromEntries(['start', 'error', 'info', 'warn', 'finish', 'cancel'].map(name => [name, vi.fn()]))
    const previous = process.exitCode
    try {
      await runScriptCli({ title: 'snapshot verification', createUi: () => ui }, async () => {
        await checked(() => ({ status: 7, stdout: '', stderr: 'Snapshot unavailable' }), 'snapshot', [])
      }, [])
      expect(process.exitCode).toBe(7)
      expect(ui.start).toHaveBeenCalledWith('snapshot verification')
      expect(ui.error).toHaveBeenCalledWith('snapshot  failed:\nSnapshot unavailable')
      expect(ui.finish).toHaveBeenCalledWith('Script failed.')
    } finally {
      process.exitCode = previous
    }
  })

  it('executes shared checks sequentially with inherited environment and stops at a failed check', async () => {
    vi.stubEnv('SCRIPT_TEST_VALUE', 'inherited')
    vi.stubEnv('DATABASE_URL', 'must not leak')
    const calls = []
    const execute = async (command, args, options) => {
      calls.push({ command, args, options })
      if (command === 'failed') throw new Error('Stop validation')
    }
    await expect(runScriptChecks([
      { command: 'check', args: ['snapshot'], label: 'Checking snapshot', env: { DATABASE_URL: '' } },
      { command: 'failed', args: [] },
      { command: 'never', args: [] }
    ], execute)).rejects.toThrow('Stop validation')
    expect(calls.map(({ command }) => command)).toEqual(['check', 'failed'])
    expect(calls[0].options).toMatchObject({ label: 'Checking snapshot', env: { DATABASE_URL: '', SCRIPT_TEST_VALUE: 'inherited' } })
    expect(calls[1].options).toEqual({})
  })
})

describe('migration script using shared CLI', () => {
  function fixture() {
    const cwd = temp()
    const script = join(cwd, 'scripts/check-postgres-migration.mjs')
    const sql = join(cwd, 'packages/better-newsletter/migrations/postgres/001_newsletter.sql')
    const compiled = join(cwd, 'packages/better-newsletter/dist/migration/postgres-schema.js')
    for (const path of [join(cwd, 'scripts'), join(cwd, 'packages/better-newsletter/migrations/postgres'), join(cwd, 'packages/better-newsletter/dist/migration')]) {
      mkdirSync(path, { recursive: true })
    }
    writeFileSync(join(cwd, 'package.json'), '{"type":"module"}')
    const source = readFileSync(fileURLToPath(new URL('../scripts/check-postgres-migration.mjs', import.meta.url)), 'utf8')
    writeFileSync(script, source.replace("'./script-cli.mjs'", JSON.stringify(new URL('../scripts/script-cli.mjs', import.meta.url).href)))
    writeFileSync(compiled, "export const renderPostgresSchemaSnapshot = () => '-- Canonical SQL\\n'\n")
    writeFileSync(sql, '-- Changed SQL\n')
    return { cwd, script, sql }
  }

  it('reports drift concisely, preserves the file, and still supports writing and verifying the canonical snapshot', () => {
    const { cwd, script, sql } = fixture()
    const run = args => spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' })
    const failed = run([])
    expect(failed.status).toBe(1)
    expect(failed.stdout.replaceAll('│', ' ').replace(/\s+/gu, ' ')).toContain('has drifted from the canonical schema')
    expect(failed.stdout).toContain('Script failed.')
    expect(failed.stderr).toBe('')
    expect(readFileSync(sql, 'utf8')).toBe('-- Changed SQL\n')
    const verbose = run(['--debug'])
    expect(verbose.status).toBe(1)
    expect(verbose.stderr).toContain('at ')
    const written = run(['--write'])
    expect(written.status).toBe(0)
    expect(written.stdout).toContain('Run summary')
    expect(readFileSync(sql, 'utf8')).toBe('-- Canonical SQL\n')
    const verified = run([])
    expect(verified.status).toBe(0)
    expect(verified.stdout).toContain('matches the canonical schema')
  })
})
