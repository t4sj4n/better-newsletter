import process from 'node:process'
import { isCancel, select, text } from '@clack/prompts'
import { versionBumpInfo } from 'bumpp'
import semver from 'semver'
import { dryRunFlags, parseScriptArgs, runScriptCli, validateScriptOptions } from './script-cli.mjs'
import { createScriptUi, reportScriptError, ScriptCancelled } from './script-ui.mjs'

// Preserve the release API while sharing presentation with other repository scripts.
export { conciseMessage, formatDuration, scriptCommand as releaseCommand } from './script-ui.mjs'

export class ReleaseCancelled extends ScriptCancelled {
  constructor(message = 'Release cancelled; no release files or branches were changed.') {
    super(message)
    this.exitCode = 130
  }
}

function selected(value) {
  if (isCancel(value)) throw new ReleaseCancelled()
  return value
}

/** Keep bumpp's version calculations while replacing its prompt with Clack. */
export async function selectReleaseVersion({ waitForInput = action => action(), ...options }, {
  interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY),
  choose = select, enter = text
} = {}) {
  if (!interactive) throw new Error('Version selection requires an interactive terminal. Run pnpm release:prepare with a selector or explicit version.')
  const choices = []
  for (const release of ['prerelease', 'patch', 'minor', 'major', 'prepatch', 'preminor', 'premajor', 'next', 'conventional']) {
    const { results } = await versionBumpInfo({ ...options, release })
    choices.push({ value: release, label: `${release} → ${results.newVersion}` })
  }
  choices.push({ value: 'none', label: `As-is → ${options.currentVersion}` })
  choices.push({ value: 'custom', label: 'Custom version…' })
  const version = selected(await waitForInput(() => choose({ message: `Select the next version (current: ${options.currentVersion})`, options: choices, initialValue: 'next' })))
  if (version === 'none') return { results: { newVersion: options.currentVersion } }
  if (version !== 'custom') return versionBumpInfo({ ...options, release: version })
  const custom = selected(await waitForInput(() => enter({
    message: 'Enter the release version',
    validate: value => semver.valid(value) ? undefined : 'Enter a valid SemVer version.'
  })))
  return versionBumpInfo({ ...options, release: custom })
}

export function createReleaseUi(options = {}) {
  return createScriptUi({ ...options, operation: 'Release', Cancelled: ReleaseCancelled })
}

export function reportReleaseError(error, options = {}) {
  return reportScriptError(error, { ...options, ui: options.ui ?? createReleaseUi(), failureMessage: 'Release failed.' })
}

export function validateReleaseOptions(options = {}) {
  validateScriptOptions(options, { subject: 'Real releases' })
}

export function parseReleaseArgs(args, kind) {
  const usage = kind === 'prepare'
    ? 'Usage: pnpm release:prepare [prerelease|patch|minor|major|version] [--dry-run [--skip-validation] [--skip-git-checks]] [--verbose|--debug]'
    : 'Usage: pnpm release:publish [--resume] [--dry-run [--skip-validation] [--skip-git-checks]] [--verbose|--debug]'
  const { options, positionals } = parseScriptArgs(args, {
    flags: { ...dryRunFlags, ...(kind === 'publish' ? { '--resume': 'resume' } : {}) },
    maxPositionals: kind === 'prepare' ? 1 : 0, usage, validate: validateReleaseOptions
  })
  return { ...options, release: positionals[0], resume: options.resume ?? false }
}

/** Catch failures at the CLI boundary; reusable release functions still reject. */
export async function runReleaseCli(kind, action, args = process.argv.slice(2)) {
  return runScriptCli({
    title: args => `${kind === 'prepare' ? 'release preparation' : 'release publication'}${args.includes('--dry-run')
      ? ` · dry-run${args.includes('--skip-git-checks') ? ' · development' : ''}${args.includes('--skip-validation') ? ' · preview only' : ''}` : ''}`,
    parseArgs: args => parseReleaseArgs(args, kind),
    createUi: createReleaseUi, failureMessage: 'Release failed.'
  }, action, args)
}
