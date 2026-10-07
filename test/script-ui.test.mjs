import { fstatSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { Writable } from 'node:stream'
import { stripVTControlCharacters } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { commandRunner, liveCommandRunner } from '../scripts/script-core.mjs'
import { createScriptUi, formatDuration, reportScriptError, ScriptCancelled } from '../scripts/script-ui.mjs'

const directories = []
afterEach(() => {
  directories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true }))
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

function temp() {
  const directory = mkdtempSync(join(tmpdir(), 'newsletter-script-ui-'))
  directories.push(directory)
  return directory
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

describe('shared command presentation', () => {
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
    const ui = createScriptUi({ output: stream, verbose, now: () => clock })
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
    await createScriptUi({ output: stream }).command(run, 'pnpm', ['build'], options)
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
    const ui = createScriptUi({ output: stream })
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
    const ui = createScriptUi({ output: stream })
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
    const ui = createScriptUi({ output: stream })
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
    const ui = createScriptUi({ output: stream })
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
      const ui = createScriptUi({ output: stream, verbose })
      await expect(ui.command(liveCommandRunner(process.cwd()), process.execPath, ['-e', 'throw new Error("Invalid artifact")']))
        .rejects.toMatchObject({ exitCode: 1 })
      const rendered = stripVTControlCharacters(output)
      expect(rendered).toContain('failed')
      expect(/at \[eval\]/u.test(rendered)).toBe(verbose)
    }
  })

  it('stops the script when an active spinner is cancelled', async () => {
    vi.stubEnv('CI', 'false')
    const stream = new Writable({ write(chunk, encoding, callback) { callback() } })
    stream.isTTY = true
    const ui = createScriptUi({ output: stream })
    await expect(ui.step('Short release step', () => {
      process.emit('SIGINT')
      return 'completed action'
    })).rejects.toMatchObject({ exitCode: 130, message: 'Script cancelled during the current step.' })
  })


})

describe('shared timings and previews', () => {
  it.each([24, 80])('renders the run summary in a box without terminal overflow (%s columns)', async columns => {
    vi.stubEnv('CI', 'true')
    let clock = 0
    let output = ''
    const stream = new Writable({ write(chunk, encoding, callback) { output += chunk; callback() } })
    stream.isTTY = true
    stream.columns = columns
    const ui = createScriptUi({ output: stream, now: () => clock })
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
    const ui = createScriptUi({ output: stream, now: () => clock })
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
    const ui = createScriptUi({ output: stream, now: () => clock })
    ui.start('timing preview')
    await ui.step('Checking repository', () => { clock += 1000 })
    const error = outcome === 'failure' ? new Error('Registry unavailable') : new ScriptCancelled()
    await expect(ui.step('Checking registry', async () => {
      await ui.input(() => { clock += 500 })
      clock += 1500
      throw error
    })).rejects.toBe(error)
    clock += 1000
    expect(reportScriptError(error, { ui })).toBe(outcome === 'failure' ? 1 : 130)
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
    createScriptUi({ output: stream }).preview(notes, 'Release notes preview')
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
