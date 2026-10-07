import console from 'node:console'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { checked } from '../scripts/script-core.mjs'
import { conciseMessage, reportScriptError, ScriptCancelled } from '../scripts/script-ui.mjs'

afterEach(() => vi.restoreAllMocks())

const recorder = () => Object.fromEntries(['error', 'warn', 'info', 'finish', 'cancel'].map(name => [name, vi.fn()]))

describe('shared error presentation', () => {
  it('keeps the command exit status and shows its cause before recovery and cleanup guidance', async () => {
    let cause
    try { await checked(() => ({ status: 7, stdout: '', stderr: 'Registry unavailable' }), 'npm', ['publish']) } catch (error) { cause = error }
    const error = new AggregateError([
      new Error('Prepared files were restored; retry preparation.', { cause }),
      new Error('Branch cleanup failed; inspect git status.')
    ], 'Preparation and cleanup failed.')
    const ui = recorder()
    const debug = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(reportScriptError(error, { ui })).toBe(7)
    expect(ui.error).toHaveBeenCalledWith('npm publish failed:\nRegistry unavailable')
    expect(ui.error.mock.invocationCallOrder[0]).toBeLessThan(ui.warn.mock.invocationCallOrder[0])
    expect(ui.warn).toHaveBeenCalledWith('Prepared files were restored; retry preparation.')
    expect(ui.warn).toHaveBeenCalledWith('Branch cleanup failed; inspect git status.')
    expect(debug).not.toHaveBeenCalled()
    reportScriptError(error, { ui, verbose: true })
    expect(debug).toHaveBeenCalledWith(error)
  })

  it('renders cancellation without an error or stack and uses exit code 130', () => {
    const ui = recorder()
    expect(reportScriptError(new ScriptCancelled(), { ui })).toBe(130)
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
      ' FAIL  test/example.test.ts > release publication > rejects modified non-release files',
      'Error: Test timed out in 5000ms.',
      'If this is a long-running test, pass a timeout value as the last argument or configure it globally with "testTimeout".',
      ' ❯ test/example.test.ts:964:5',
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
    expect(reportScriptError(error, { ui })).toBe(1)
    const message = ui.error.mock.calls[0][0]
    expect(message).toContain('Vitest failed (exit 1):')
    expect(message).toContain('FAIL test/example.test.ts > release publication > rejects modified non-release files')
    expect(message).toContain('Error: Test timed out in 5000ms.')
    expect(message).not.toMatch(/Guard unavailable|matching cause stack|964\||❯/u)
    expect(debug).not.toHaveBeenCalled()
    reportScriptError(error, { ui, verbose: true })
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
    expect(reportScriptError(error, { ui })).toBe(7)
    const message = ui.error.mock.calls[0][0]
    expect(message).toContain('case 0\nAssertionError: expected false to be true')
    expect(message).toContain('- true\n+ false')
    expect(message).toContain('case 2')
    expect(message).toContain('2 more failed tests/suites')
    expect(message).not.toMatch(/Expected warning|case 3|10\||❯/u)
  })

})
