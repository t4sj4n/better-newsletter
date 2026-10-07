import { existsSync, readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { authenticatedNpm } from '../scripts/npm-auth.mjs'

afterEach(() => vi.unstubAllEnvs())

describe('token-authenticated npm commands', () => {
  it('rejects a missing token before running npm', async () => {
    vi.stubEnv('NPM_TOKEN', '')
    const run = vi.fn()
    await expect(authenticatedNpm(run, ['publish', 'package.tgz'])).rejects.toThrow('Publishing requires NPM_TOKEN')
    expect(run).not.toHaveBeenCalled()
  })

  it.each(['whoami', 'publish'])('authenticates %s without storing credentials or opening an interactive prompt', async command => {
    const token = 'test-only-secret-token'
    vi.stubEnv('NPM_TOKEN', token)
    let config
    const result = await authenticatedNpm(async (program, args, options) => {
      config = args[args.indexOf('--userconfig') + 1]
      expect(program).toBe('npm')
      expect(args).not.toContain(token)
      expect(readFileSync(config, 'utf8')).toBe('//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n')
      expect(options.env.NPM_TOKEN).toBe(token)
      expect(options.interactive).not.toBe(true)
      expect(options.onOutput).toBeUndefined()
      return { status: 0, stdout: 'authenticated-user', stderr: '' }
    }, [command])
    expect(result).toBe('authenticated-user')
    expect(existsSync(config)).toBe(false)
  })

  it('redacts credentials from command failures and removes the temporary configuration', async () => {
    const token = 'test-only-secret-token'
    vi.stubEnv('NPM_TOKEN', token)
    let config
    let failure
    try {
      await authenticatedNpm(async (program, args) => {
        config = args[args.indexOf('--userconfig') + 1]
        return { status: 1, stdout: '', stderr: `Rejected ${token}` }
      }, ['publish', 'package.tgz'])
    } catch (error) {
      failure = error
    }
    expect(failure.message).toContain('[REDACTED]')
    expect(JSON.stringify(failure.commandResult)).not.toContain(token)
    expect(existsSync(config)).toBe(false)
  })
})
