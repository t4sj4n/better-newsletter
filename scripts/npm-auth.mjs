import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { checked } from './script-core.mjs'

export function requireNpmToken() {
  const token = process.env.NPM_TOKEN?.trim()
  if (!token) throw new Error('Publishing requires NPM_TOKEN: use a granular npm token with write access to both packages and Bypass 2FA enabled.')
  return token
}

/** Keep credentials out of command arguments and temporary files. */
export async function authenticatedNpm(run, args) {
  const token = requireNpmToken()
  const directory = mkdtempSync(join(tmpdir(), 'newsletter-npm-auth-'))
  const config = join(directory, 'npmrc')
  try {
    writeFileSync(config, '//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n', { mode: 0o600 })
    const redact = text => text.replaceAll(token, '[REDACTED]')
    const safeRun = async (command, commandArgs, options) => {
      const result = await run(command, commandArgs, options)
      return { ...result, stdout: redact(result.stdout), stderr: redact(result.stderr) }
    }
    return await checked(safeRun, 'npm', [...args, '--userconfig', config], {
      env: { ...process.env, NPM_TOKEN: token },
      // npm output is checked and redacted before errors reach verbose logging.
      onOutput: undefined
    })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}
