import { execFileSync, spawnSync } from 'node:child_process'
import console from 'node:console'
import { fstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { PassThrough, Writable } from 'node:stream'
import { fileURLToPath, URL } from 'node:url'
import { stripVTControlCharacters } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { select } from '@clack/prompts'
import { checked, commandRunner, liveCommandRunner, requireCurrentMain } from '../scripts/release-core.mjs'
import { conciseMessage, createReleaseUi, formatDuration, parseReleaseArgs, ReleaseCancelled, reportReleaseError, selectReleaseVersion } from '../scripts/release-ui.mjs'

const directories = []
afterEach(() => {
  directories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true }))
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

function temp() {
  const directory = mkdtempSync(join(tmpdir(), 'newsletter-release-ui-'))
  directories.push(directory)
  return directory
}

function recorder() {
  return Object.fromEntries(['error', 'warn', 'info', 'finish', 'cancel'].map(name => [name, vi.fn()]))
}

// Model Clack's cursor/erase sequences so tests catch overwritten guides and stale rows.
function terminalLines(raw) {
  const rows = [[]]
  let row = 0
  let column = 0
  const escape = String.fromCharCode(27)
  const tokens = new RegExp(`${escape}\\[[\\d;?]*[A-Za-z]|[^${escape}]`, 'gu')
  for (const token of raw.matchAll(tokens)) {
    const value = token[0]
    if (value.startsWith('\u001b[')) {
      const code = value.at(-1)
      const count = Number.parseInt(value.slice(2), 10) || 1
      if (code === 'A') row = Math.max(0, row - count)
      if (code === 'B') row += count
      if (code === 'G') column = count - 1
      if (code === 'K') rows[row] = []
      if (code === 'J') {
        rows[row] = (rows[row] ?? []).slice(0, column)
        rows.splice(row + 1)
      }
    } else if (value === '\n') {
      row++
      column = 0
    } else if (value === '\r') column = 0
    else {
      rows[row] ??= []
      rows[row][column++] = value
    }
  }
  return rows.map(line => line.join('')).filter(Boolean)
}

describe('release CLI failures', () => {
  it.each(['prepare', 'publish'])('%s renders a dirty-tree failure without Node stacks and exits non-zero', kind => {
    const cwd = temp()
    execFileSync('git', ['init', '-b', 'main'], { cwd, stdio: 'pipe' })
    writeFileSync(join(cwd, 'untracked'), 'Preserve this work')
    const script = fileURLToPath(new URL(`../scripts/release-${kind}.mjs`, import.meta.url))
    const result = spawnSync(process.execPath, [script, ...(kind === 'prepare' ? ['prerelease'] : [])], { cwd, encoding: 'utf8' })
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('Commit or stash all tracked and untracked changes before releasing.')
    expect(result.stdout).toContain('Release failed.')
    expect(result.stdout).not.toMatch(/\s+at |file:\/\//u)
    expect(result.stdout).not.toContain('\u001b[?25')
    expect(result.stderr).toBe('')
  })

  it.each(['--verbose', '--debug'])('only prints stack traces with %s', flag => {
    const script = fileURLToPath(new URL('../scripts/release-prepare.mjs', import.meta.url))
    const result = spawnSync(process.execPath, [script, '--unknown', flag], { encoding: 'utf8' })
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('Usage: pnpm release:prepare')
    expect(result.stderr).toContain('at parseReleaseArgs')
  })

  it('keeps the command exit status and shows its cause before recovery and cleanup guidance', async () => {
    let cause
    try { await checked(() => ({ status: 7, stdout: '', stderr: 'Registry unavailable' }), 'npm', ['publish']) } catch (error) { cause = error }
    const error = new AggregateError([
      new Error('Prepared files were restored; retry preparation.', { cause }),
      new Error('Branch cleanup failed; inspect git status.')
    ], 'Preparation and cleanup failed.')
    const ui = recorder()
    const debug = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(reportReleaseError(error, { ui })).toBe(7)
    expect(ui.error).toHaveBeenCalledWith('npm publish failed:\nRegistry unavailable')
    expect(ui.error.mock.invocationCallOrder[0]).toBeLessThan(ui.warn.mock.invocationCallOrder[0])
    expect(ui.warn).toHaveBeenCalledWith('Prepared files were restored; retry preparation.')
    expect(ui.warn).toHaveBeenCalledWith('Branch cleanup failed; inspect git status.')
    expect(debug).not.toHaveBeenCalled()
    reportReleaseError(error, { ui, verbose: true })
    expect(debug).toHaveBeenCalledWith(error)
  })

  it('renders cancellation without an error or stack and uses exit code 130', () => {
    const ui = recorder()
    expect(reportReleaseError(new ReleaseCancelled(), { ui })).toBe(130)
    expect(ui.cancel).toHaveBeenCalled()
    expect(ui.error).not.toHaveBeenCalled()
  })

  it('removes subprocess Node stacks and source excerpts while retaining the failure', () => {
    expect(conciseMessage('file:///tmp/check.mjs:1\nthrow new Error("Invalid artifact")\n      ^\n\nError: Invalid artifact\n    at file:///tmp/check.mjs:1:7\n    at async run (node:internal/modules/run_main:1:2)\n\nNode.js v26.7.0'))
      .toBe('Error: Invalid artifact')
    expect(conciseMessage('Error: Invalid artifact\n    ... 8 lines matching cause stack trace ...\n    964| await publishRelease()\n       | ^\n    at run (/tmp/release.mjs:964:5)'))
      .toBe('Error: Invalid artifact')
  })

  it.each(['stdout', 'stderr'])('prioritizes actual Vitest failures reported on %s over expected test logs', async stream => {
    const expectedLogs = [
      'stderr | test/nuxt.test.ts > Nuxt server integration > fails its guard error check',
      '[h3] [unhandled] H3Error: Guard unavailable',
      '    at Object.<anonymous> (/tmp/test/nuxt.test.ts:645:17)',
      '    ... 8 lines matching cause stack trace ...',
      '  cause: Error: Guard unavailable', '  statusCode: 500,', '  fatal: false,', '  unhandled: true,'
    ].join('\n')
    const failure = [
      '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯',
      ' FAIL  test/release-prepare.test.mjs > release publication > rejects modified non-release files',
      'Error: Test timed out in 5000ms.',
      'If this is a long-running test, pass a timeout value as the last argument or configure it globally with "testTimeout".',
      ' ❯ test/release-prepare.test.mjs:964:5',
      '    964| await expect(publishRelease(cwd, { run, resume: true })).rejects.toThrow()',
      '       | ^',
      '    965| expect(mutations(state)).toEqual([])',
      '⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯ [1/1] ⎯',
      ' Test Files  1 failed | 22 passed (23)', '      Tests  1 failed | 538 passed (539)'
    ].join('\n')
    const result = { status: 1, stdout: '', stderr: expectedLogs }
    result[stream] += `\n${failure}`
    let error
    try { await checked(() => result, 'pnpm', ['exec', 'vitest', 'run']) } catch (cause) { error = cause }
    const ui = recorder()
    const debug = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(reportReleaseError(error, { ui })).toBe(1)
    const message = ui.error.mock.calls[0][0]
    expect(message).toContain('Vitest failed (exit 1):')
    expect(message).toContain('FAIL test/release-prepare.test.mjs > release publication > rejects modified non-release files')
    expect(message).toContain('Error: Test timed out in 5000ms.')
    expect(message).not.toMatch(/Guard unavailable|matching cause stack|964\||❯/u)
    expect(debug).not.toHaveBeenCalled()
    reportReleaseError(error, { ui, verbose: true })
    expect(debug).toHaveBeenCalledWith(error)
    if (stream === 'stdout') expect(debug).toHaveBeenCalledWith(`Command stdout:\n${result.stdout}`)
  })

  it('reports multiple Vitest failures without losing the first reason or assertion details', async () => {
    const stdout = Array.from({ length: 5 }, (_, index) => [
      ` FAIL  test/example.test.ts > case ${index}`,
      'AssertionError: expected false to be true', '', '- Expected', '+ Received', '', '- true', '+ false',
      ' ❯ test/example.test.ts:10:5', '     10| expect(false).toBe(true)', '       | ^'
    ].join('\n')).join('\n\n')
    let error
    try { await checked(() => ({ status: 7, stdout, stderr: 'Expected warning' }), 'pnpm', ['exec', 'vitest', 'run']) } catch (cause) { error = cause }
    const ui = recorder()
    expect(reportReleaseError(error, { ui })).toBe(7)
    const message = ui.error.mock.calls[0][0]
    expect(message).toContain('case 0\nAssertionError: expected false to be true')
    expect(message).toContain('- true\n+ false')
    expect(message).toContain('case 2')
    expect(message).toContain('2 more failed tests/suites')
    expect(message).not.toMatch(/Expected warning|case 3|10\||❯/u)
  })

  it('accepts debug flags alongside selectors and resume, while rejecting unexpected arguments', () => {
    expect(parseReleaseArgs(['--debug', 'prerelease'], 'prepare')).toMatchObject({ verbose: true, release: 'prerelease' })
    expect(parseReleaseArgs(['--resume', '--verbose'], 'publish')).toMatchObject({ verbose: true, resume: true })
    expect(parseReleaseArgs(['--dry-run', 'prerelease', '--debug'], 'prepare')).toMatchObject({ dryRun: true, release: 'prerelease', verbose: true })
    expect(parseReleaseArgs(['--dry-run', '--resume'], 'publish')).toMatchObject({ dryRun: true, resume: true })
    expect(() => parseReleaseArgs(['--dry-run', '--resume'], 'prepare')).toThrow('Usage:')
    expect(() => parseReleaseArgs(['patch', 'minor'], 'prepare')).toThrow('Usage:')
    expect(() => parseReleaseArgs(['--force'], 'publish')).toThrow('Usage:')
    expect(parseReleaseArgs(['prerelease', '--dry-run', '--skip-validation', '--debug'], 'prepare'))
      .toMatchObject({ dryRun: true, skipValidation: true, verbose: true, release: 'prerelease' })
    expect(parseReleaseArgs(['--resume', '--skip-validation', '--dry-run'], 'publish'))
      .toMatchObject({ dryRun: true, skipValidation: true, resume: true })
    for (const kind of ['prepare', 'publish']) {
      expect(() => parseReleaseArgs(['--skip-validation'], kind)).toThrow('--skip-validation requires --dry-run')
      expect(() => parseReleaseArgs(['--skip-git-checks'], kind)).toThrow('--skip-git-checks requires --dry-run')
      expect(parseReleaseArgs(['--dry-run', '--skip-git-checks', '--skip-validation'], kind))
        .toMatchObject({ dryRun: true, skipGitChecks: true, skipValidation: true })
    }
  })

  it.each(['prepare', 'publish'])('%s rejects skipping validation without dry-run at the CLI boundary', kind => {
    const cwd = temp()
    const script = fileURLToPath(new URL(`../scripts/release-${kind}.mjs`, import.meta.url))
    const result = spawnSync(process.execPath, [script, '--skip-validation'], { cwd, encoding: 'utf8' })
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('--skip-validation requires --dry-run')
    expect(result.stdout).not.toContain('Checking clean main')
    expect(result.stderr).toBe('')
  })

  it.each(['prepare', 'publish'])('%s rejects skipping Git checks without dry-run before accessing the repository', kind => {
    const script = fileURLToPath(new URL(`../scripts/release-${kind}.mjs`, import.meta.url))
    const result = spawnSync(process.execPath, [script, '--skip-git-checks'], { cwd: temp(), encoding: 'utf8' })
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('--skip-git-checks requires --dry-run')
    expect(result.stdout).not.toContain('Checking clean main')
    expect(result.stderr).toBe('')
  })
})

describe('live release commands', () => {
  it.each([false, true])('animates commands and keeps wrapped logs inside the guide (verbose: %s)', async verbose => {
    vi.stubEnv('CI', 'false')
    vi.stubEnv('NO_COLOR', undefined)
    vi.stubEnv('FORCE_COLOR', '1')
    let output = ''
    const stream = new Writable({ write(chunk, encoding, callback) { output += chunk; callback() } })
    stream.isTTY = true
    stream.columns = 32
    let emit
    let finish
    let clock = 0
    const run = (command, args, { onOutput }) => {
      emit = onOutput
      return new Promise(resolve => { finish = resolve })
    }
    const label = 'pnpm exec vitest run test/a-long-release-validation-test-file.mjs'
    const ui = createReleaseUi({ output: stream, verbose, now: () => clock })
    const pending = ui.command(run, 'pnpm', label.split(' ').slice(1),
      { label: 'Running release tests', completed: 'Release tests passed' })
    try {
      await vi.waitFor(() => expect(output).toMatch(/◐|◓|◑/u))
      clock = 2500
      emit('a'.repeat(83))
      await vi.waitFor(() => expect(terminalLines(output)[1]).toMatch(/^[◒◐◓◑] {2}Running.*\(2\.5s\)$/u))
      const active = terminalLines(output)
      expect(active[2]).toMatch(/^│ {2}\$ pnpm/u)
      expect(active.filter(line => /[◒◐◓◑]/u.test(line))).toHaveLength(1)
      expect(active.some(line => line.includes('Running pnpm'))).toBe(false)
      expect(active.filter(line => line.includes('aaa')).every(line => line.startsWith('│  '))).toBe(true)
      expect(active.every(line => line.length < stream.columns)).toBe(true)
      for (let index = 0; index < 12; index++) emit(`progress ${index}`)
      clock = 61234
      const checkpoint = output.length
      await vi.waitFor(() => expect(output.slice(checkpoint)).toMatch(/[◒◐◓◑]/u))
      const rolling = terminalLines(output)
      expect(rolling[1]).toMatch(/^[◒◐◓◑] {2}Running.*\(1m 1s\)$/u)
      expect(rolling[2]).toMatch(/^│ {2}\$ pnpm/u)
      expect(rolling.filter(line => /[◒◐◓◑]/u.test(line))).toHaveLength(1)
      expect(rolling.filter(line => line.includes('progress')).every(line => line.startsWith('│  '))).toBe(true)
      expect(rolling.some(line => line.includes('aaa'))).toBe(false)
      finish({ status: 0, stdout: '', stderr: '' })
      await pending
      const completed = terminalLines(output)
      expect(completed[0]).toBe('│')
      expect(completed[1]).toMatch(/^◆ {2}/u)
      expect(completed.join('\n')).toContain('(1m 1s)')
      expect(completed.slice(2).every(line => line.startsWith('│'))).toBe(true)
      expect(completed.some(line => /◒|◐|◓|◑/u.test(line))).toBe(false)
      expect(completed.every(line => line.length < stream.columns)).toBe(true)
      expect(completed.some(line => line.includes('aaa'))).toBe(verbose)
    } finally {
      finish({ status: 0, stdout: '', stderr: '' })
      await pending
    }
  })

  it('shows step headings and dimmed commands in CI without animations', async () => {
    vi.stubEnv('CI', 'true')
    vi.stubEnv('NO_COLOR', undefined)
    vi.stubEnv('FORCE_COLOR', '1')
    let output = ''
    const stream = new Writable({ write(chunk, encoding, callback) { output += chunk; callback() } })
    stream.isTTY = true
    const run = vi.fn(async () => ({ status: 0, stdout: '', stderr: '' }))
    const options = { label: 'Building packages', completed: 'Packages built', env: { RELEASE_UI_TEST: 'custom' }, input: 'data' }
    await createReleaseUi({ output: stream }).command(run, 'pnpm', ['build'], options)
    expect(stripVTControlCharacters(output)).toContain('◇  Building packages\n│  $ pnpm build')
    expect(output).toContain('\u001b[2m$ pnpm build\u001b[22m')
    expect(stripVTControlCharacters(output)).toContain('◆  Packages built')
    expect(output).not.toContain('\u001b[?25')
    expect(run).toHaveBeenCalledWith('pnpm', ['build'], {
      env: options.env, input: options.input, onOutput: expect.any(Function)
    })
  })

  it.each(['failure', 'cancellation'])('clears the animated heading on command %s', async outcome => {
    vi.stubEnv('CI', 'false')
    let output = ''
    const stream = new Writable({ write(chunk, encoding, callback) { output += chunk; callback() } })
    stream.isTTY = true
    stream.columns = 24
    const ui = createReleaseUi({ output: stream })
    const run = async (command, args, { onOutput }) => {
      onOutput('A diagnostic message that wraps inside the guide')
      if (outcome === 'cancellation') process.emit('SIGINT')
      return { status: outcome === 'failure' ? 7 : 0, stdout: '', stderr: 'Registry unavailable' }
    }
    await expect(ui.command(run, 'npm', ['view', 'better-newsletter'], {
      label: 'Checking version availability', completed: 'Version available'
    })).rejects.toMatchObject({ exitCode: outcome === 'failure' ? 7 : 130 })
    const lines = terminalLines(output)
    expect(lines[1]).toMatch(/^■ {2}Checking version/u)
    expect(lines.every(line => line.length < stream.columns)).toBe(true)
    expect(lines.slice(2).every(line => line.startsWith('│  '))).toBe(true)
    expect(lines.some(line => /[◒◐◓◑]/u.test(line))).toBe(false)
    expect(lines.some(line => line.includes('$ npm'))).toBe(false)
    expect(output).toContain('\u001b[?25h')
    const checkpoint = output
    await new Promise(resolve => globalThis.setTimeout(resolve, 150))
    expect(output).toBe(checkpoint)
  })

  it('wraps piped command output and status messages without cursor animations', async () => {
    let output = ''
    const stream = new Writable({ write(chunk, encoding, callback) { output += chunk; callback() } })
    stream.columns = 24
    const ui = createReleaseUi({ output: stream })
    await ui.step('A long short-running validation step', async () => {})
    ui.warn('A warning that must stay inside the guide')
    await ui.command(async (command, args, { onOutput }) => {
      onOutput('\u001b[31m' + '界📦'.repeat(8) + '\u001b[0m')
      onOutput('x'.repeat(85))
      return { status: 0, stdout: '', stderr: '' }
    }, 'node', ['a-very-long-script-name-for-validation.mjs'])
    const rendered = stripVTControlCharacters(output)
    const lines = rendered.split('\n').filter(Boolean)
    expect(lines.every(line => /^[│◇◆▲] {2}|^│$/u.test(line))).toBe(true)
    expect(lines.every(line => line.length < stream.columns)).toBe(true)
    expect(rendered).toContain('◆  A long short-running')
    expect(output).not.toContain('\u001b[?25')
    expect(lines.filter(line => line.includes('xxx')).every(line => line.startsWith('│  '))).toBe(true)
  })

  it('keeps inherited npm authentication output free of spinner cursor commands', async () => {
    let output = ''
    const stream = new Writable({ write(chunk, encoding, callback) { output += chunk; callback() } })
    stream.isTTY = true
    const ui = createReleaseUi({ output: stream })
    await ui.command(async () => ({ status: 0, stdout: '', stderr: '' }), 'npm', ['publish'],
      { label: 'Publishing package', completed: 'Package published', interactive: true })
    expect(stripVTControlCharacters(output)).toContain('Package published')
    expect(output).not.toContain('\u001b[?25')
  })

  it('uses a consistent success symbol after short steps', async () => {
    vi.stubEnv('CI', 'false')
    let output = ''
    const stream = new Writable({ write(chunk, encoding, callback) { output += chunk; callback() } })
    stream.isTTY = true
    stream.columns = 24
    const ui = createReleaseUi({ output: stream })
    await ui.step('A long short-running validation step', () => new Promise(resolve => globalThis.setTimeout(resolve, 350)))
    const lines = terminalLines(output)
    expect(lines[1]).toMatch(/^◆ {2}/u)
    expect(lines.slice(2).every(line => line.startsWith('│  '))).toBe(true)
    expect(lines.every(line => line.length < stream.columns)).toBe(true)
  })

  it('delivers both output streams before completion, including a final line without a newline', async () => {
    let firstOutput
    const firstLine = new Promise(resolve => { firstOutput = resolve })
    const lines = []
    let completed = false
    const result = liveCommandRunner(process.cwd())(process.execPath, ['-e',
      'console.log("started"); setTimeout(() => { console.error("progress"); process.stdout.write("finished"); }, 200)'],
    { onOutput: line => { lines.push(line); firstOutput() } }).then(value => { completed = true; return value })
    await firstLine
    expect(completed).toBe(false)
    expect(await result).toEqual({ status: 0, stdout: 'started\nfinished', stderr: 'progress\n' })
    expect(lines).toEqual(expect.arrayContaining(['started', 'progress', 'finished']))
  })

  it('preserves stdin and environment overrides for commands such as gh release create', async () => {
    const result = await liveCommandRunner(process.cwd())(process.execPath, ['-e',
      'process.stdin.pipe(process.stdout); console.error(process.env.RELEASE_UI_TEST)'],
    { input: 'Reviewed notes.\n', env: { ...process.env, RELEASE_UI_TEST: 'custom environment' } })
    expect(result).toEqual({ status: 0, stdout: 'Reviewed notes.\n', stderr: 'custom environment\n' })
  })

  it('inherits all terminal descriptors so npm browser/OTP authentication remains available', async () => {
    const cwd = temp()
    const path = join(cwd, 'stdio.json')
    const result = await liveCommandRunner(cwd)(process.execPath, ['-e',
      'const fs = require("node:fs"); fs.writeFileSync(process.argv[1], JSON.stringify([0,1,2].map(fd => { const stat = fs.fstatSync(fd); return [stat.dev, stat.ino]; })));', path], { interactive: true })
    expect(result).toEqual({ status: 0, stdout: '', stderr: '' })
    const descriptors = JSON.parse(readFileSync(path, 'utf8'))
    expect(descriptors).toEqual([0, 1, 2].map(fd => {
      const stat = fstatSync(fd)
      return [stat.dev, stat.ino]
    }))
  })

  it('fails rather than silently dropping command output beyond the buffer limit', async () => {
    await expect(liveCommandRunner(process.cwd())(process.execPath, ['-e', 'console.log("x".repeat(1024))'], { maxBuffer: 128 }))
      .rejects.toThrow('output limit')
  })

  it.each([commandRunner, liveCommandRunner])('preserves failed-command and signal exit codes', async runner => {
    const run = runner(process.cwd())
    expect((await run(process.execPath, ['-e', 'process.exit(9)'])).status).toBe(9)
    expect((await run(process.execPath, ['-e', 'process.kill(process.pid, "SIGTERM")'])).status).toBe(143)
  })

  it('reports a missing executable as a failure rather than successful empty output', async () => {
    await expect(liveCommandRunner(process.cwd())('newsletter-release-missing-executable', []))
      .rejects.toThrow('Cannot run newsletter-release-missing-executable')
  })

  it('uses task logs and suppresses child stacks by default, retaining them in verbose mode', async () => {
    for (const verbose of [false, true]) {
      let output = ''
      const stream = new Writable({ write(chunk, encoding, callback) { output += chunk; callback() } })
      stream.isTTY = true
      const ui = createReleaseUi({ output: stream, verbose })
      await expect(ui.command(liveCommandRunner(process.cwd()), process.execPath, ['-e', 'throw new Error("Invalid artifact")']))
        .rejects.toMatchObject({ exitCode: 1 })
      const rendered = stripVTControlCharacters(output)
      expect(rendered).toContain('failed')
      expect(/at \[eval\]/u.test(rendered)).toBe(verbose)
    }
  })

  it('stops the release workflow when an active spinner is cancelled', async () => {
    const stream = new Writable({ write(chunk, encoding, callback) { callback() } })
    stream.isTTY = true
    const ui = createReleaseUi({ output: stream })
    await expect(ui.step('Short release step', () => {
      process.emit('SIGINT')
      return 'completed action'
    })).rejects.toMatchObject({ exitCode: 130, message: 'Release cancelled during the current step.' })
  })

  it('animates while the repository check waits for a subprocess', async () => {
    let output = ''
    const stream = new Writable({ write(chunk, encoding, callback) { output += chunk; callback() } })
    stream.isTTY = true
    const ui = createReleaseUi({ output: stream })
    const live = liveCommandRunner(process.cwd())
    const commit = 'a'.repeat(40)
    const run = async (command, args) => {
      if (args[0] === 'fetch') return live(process.execPath, ['-e', 'setTimeout(() => {}, 250)'])
      return { status: 0, stderr: '', stdout: args[0] === 'branch' ? 'main' : args[0] === 'rev-parse' ? commit : '' }
    }
    let completed = false
    const check = ui.step('Checking repository', () => requireCurrentMain(run)).then(value => { completed = true; return value })
    await vi.waitFor(() => expect(stripVTControlCharacters(output)).toContain('Checking repository'), { timeout: 1000 })
    expect(completed).toBe(false)
    expect(await check).toBe(commit)
  })
})

describe('release timings and previews', () => {
  it.each([24, 80])('renders the run summary in a box without terminal overflow (%s columns)', async columns => {
    vi.stubEnv('CI', 'true')
    let clock = 0
    let output = ''
    const stream = new Writable({ write(chunk, encoding, callback) { output += chunk; callback() } })
    stream.isTTY = true
    stream.columns = columns
    const ui = createReleaseUi({ output: stream, now: () => clock })
    ui.start('timing preview')
    await ui.step('Checking repository', () => { clock += 1234 })
    ui.finish('Done')
    const lines = terminalLines(output)
    expect(lines.some(line => /^◇ {2}Run summary ─+╮$/u.test(line))).toBe(true)
    expect(lines.some(line => /^├─+╯$/u.test(line))).toBe(true)
    expect(lines.some(line => line.startsWith('│  Total') && line.endsWith('│'))).toBe(true)
    expect(lines.every(line => line.length < columns)).toBe(true)
  })
  it.each([
    [0, '0ms'], [321, '321ms'], [1234, '1.2s'], [59999, '1m 0s'],
    [90000, '1m 30s'], [3601000, '1h 0m 1s']
  ])('formats %s milliseconds as %s', (duration, expected) => {
    expect(formatDuration(duration)).toBe(expected)
  })

  it('separates prompt wait from total elapsed time without double-counting nested waits', async () => {
    let clock = 100
    let output = ''
    const stream = new Writable({ write(chunk, encoding, callback) { output += chunk; callback() } })
    const ui = createReleaseUi({ output: stream, now: () => clock })
    ui.start('timing preview')
    await ui.step('Checking repository', () => { clock += 1250 })
    await ui.input(async () => {
      clock += 500
      await ui.input(() => { clock += 1500 })
    })
    await ui.command(async () => {
      clock += 2500
      return { status: 0, stdout: '', stderr: '' }
    }, 'pnpm', ['build'], { label: 'Building packages', completed: 'Packages built' })
    clock += 250 // Includes time outside instrumented steps, such as cleanup.
    ui.finish('Done')
    const rendered = stripVTControlCharacters(output)
    expect(rendered).toContain('Checking repository (1.3s)')
    expect(rendered).toContain('Packages built (2.5s)')
    expect(rendered).toContain('Total          6.0s')
    expect(rendered).toContain('Execution      4.0s (excluding prompts)')
    expect(rendered).toContain('Prompt wait    2.0s (1 prompt)')
    expect(rendered).toContain('Steps          2 completed · 0 failed · 0 cancelled')
    expect(rendered).toContain('Commands       1')
    expect(rendered.indexOf('Building packages · 2.5s')).toBeLessThan(rendered.indexOf('Checking repository · 1.3s'))
  })

  it.each(['failure', 'cancellation'])('includes failed or cancelled steps in the %s summary', async outcome => {
    let clock = 0
    let output = ''
    const stream = new Writable({ write(chunk, encoding, callback) { output += chunk; callback() } })
    const ui = createReleaseUi({ output: stream, now: () => clock })
    ui.start('timing preview')
    await ui.step('Checking repository', () => { clock += 1000 })
    const error = outcome === 'failure' ? new Error('Registry unavailable') : new ReleaseCancelled()
    await expect(ui.step('Checking registry', async () => {
      await ui.input(() => { clock += 500 })
      clock += 1500
      throw error
    })).rejects.toBe(error)
    clock += 1000
    expect(reportReleaseError(error, { ui })).toBe(outcome === 'failure' ? 1 : 130)
    const rendered = stripVTControlCharacters(output)
    expect(rendered).toContain('Total          4.0s')
    expect(rendered).toContain('Execution      3.5s (excluding prompts)')
    expect(rendered).toContain('Prompt wait    500ms (1 prompt)')
    expect(rendered).toContain(outcome === 'failure'
      ? '1 completed · 1 failed · 0 cancelled' : '1 completed · 0 failed · 1 cancelled')
    expect(rendered).toContain(`Checking registry · 2.0s (${outcome === 'failure' ? 'failed' : 'cancelled'})`)
    expect(rendered.match(/Run summary/gu)).toHaveLength(1)
  })

  it.each([false, true])('keeps long release notes complete and wrapped (TTY: %s)', tty => {
    let output = ''
    const stream = new Writable({ write(chunk, encoding, callback) { output += chunk; callback() } })
    stream.isTTY = tty
    stream.columns = 32
    stream.rows = 10
    const notes = ['## v1.0.0', '', '### 🚀 Enhancements', '',
      ...Array.from({ length: 40 }, (_, index) => `- Entry-${index}: Improved release previews 界📦 (https://example.com/pull/${index})`),
      '', '### Fixes', '', '- Final-entry: Preserve the complete preview.'].join('\n')
    createReleaseUi({ output: stream }).preview(notes, 'Release notes preview')
    const lines = stripVTControlCharacters(output).split('\n').filter(Boolean)
    const rendered = lines.map(line => line.slice(3)).join('\n')
    expect(rendered).toContain('Release notes preview')
    expect(rendered).toContain('## v1.0.0')
    expect(rendered).toContain('### 🚀 Enhancements')
    for (let index = 0; index < 40; index++) expect(rendered).toContain(`Entry-${index}:`)
    expect(rendered).toContain('Final-entry:')
    expect(lines.every(line => line.length < stream.columns)).toBe(true)
    expect(lines.slice(2).every(line => /^│(?: {2}|$)/u.test(line))).toBe(true)
    expect(output).not.toContain('\u001b[?25')
    expect(rendered).not.toContain('use --verbose')
  })
})

describe('Clack version selection', () => {
  const options = { currentVersion: '0.1.0-rc.0', preid: 'rc', commit: false, tag: false, push: false, noGitCheck: true }
  it('keeps the existing prerelease channel and bumpp version calculations', async () => {
    const choose = vi.fn(async () => 'next')
    const result = await selectReleaseVersion(options, { interactive: true, choose })
    expect(result.results.newVersion).toBe('0.1.0-rc.1')
    expect(choose.mock.calls[0][0].options).toContainEqual({ value: 'next', label: 'next → 0.1.0-rc.1' })
  })

  it('supports explicit custom versions', async () => {
    const result = await selectReleaseVersion(options, { interactive: true, choose: async () => 'custom', enter: async () => '0.2.0-beta.1' })
    expect(result.results.newVersion).toBe('0.2.0-beta.1')
  })

  it('measures only input waits for version selection and custom entry', async () => {
    let clock = 0
    let output = ''
    const stream = new Writable({ write(chunk, encoding, callback) { output += chunk; callback() } })
    const ui = createReleaseUi({ output: stream, now: () => clock })
    ui.start('version selection')
    const result = await selectReleaseVersion({ ...options, waitForInput: action => ui.input(action) }, {
      interactive: true,
      choose: async () => { clock += 1000; return 'custom' },
      enter: async () => { clock += 1500; return '0.2.0-beta.1' }
    })
    expect(result.results.newVersion).toBe('0.2.0-beta.1')
    clock += 1000
    ui.finish('Done')
    const rendered = stripVTControlCharacters(output)
    expect(rendered).toContain('Total          3.5s')
    expect(rendered).toContain('Execution      1.0s (excluding prompts)')
    expect(rendered).toContain('Prompt wait    2.5s (2 prompts)')
  })

  it('keeps prompt timing when selection is cancelled', async () => {
    let clock = 0
    let output = ''
    const stream = new Writable({ write(chunk, encoding, callback) { output += chunk; callback() } })
    const ui = createReleaseUi({ output: stream, now: () => clock })
    const error = new ReleaseCancelled()
    await expect(selectReleaseVersion({ ...options, waitForInput: action => ui.input(action) }, {
      interactive: true,
      choose: async () => { clock += 750; throw error }
    })).rejects.toBe(error)
    expect(reportReleaseError(error, { ui })).toBe(130)
    const rendered = stripVTControlCharacters(output)
    expect(rendered).toContain('Total          750ms')
    expect(rendered).toContain('Execution      0ms (excluding prompts)')
    expect(rendered).toContain('Prompt wait    750ms (1 prompt)')
    expect(rendered).toContain('0 completed · 0 failed · 0 cancelled')
  })

  it.each(['select', 'custom'])('handles cancellation of the %s prompt', async stage => {
    const controller = new globalThis.AbortController()
    const cancellation = select({
      message: 'Cancel selection', options: [{ value: 'next' }],
      input: new PassThrough(), output: new Writable({ write(chunk, encoding, callback) { callback() } }),
      signal: controller.signal
    })
    controller.abort()
    const cancelled = await cancellation
    await expect(selectReleaseVersion(options, {
      interactive: true, choose: async () => stage === 'custom' ? 'custom' : cancelled, enter: async () => cancelled
    })).rejects.toBeInstanceOf(ReleaseCancelled)
  })

  it('does not open a prompt in non-interactive environments', async () => {
    const choose = vi.fn()
    await expect(selectReleaseVersion(options, { interactive: false, choose })).rejects.toThrow('interactive terminal')
    expect(choose).not.toHaveBeenCalled()
  })
})
