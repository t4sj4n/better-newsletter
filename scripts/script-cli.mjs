import process from 'node:process'
import { createScriptUi, reportScriptError } from './script-ui.mjs'

export const diagnosticFlags = Object.freeze({ '--verbose': 'verbose', '--debug': 'verbose' })
/** Parse boolean flags and positionals without imposing a release-specific interface. */
export function parseScriptArgs(args, { flags = {}, maxPositionals = 0, usage = 'Unexpected script arguments.', validate = () => {} } = {}) {
  const definitions = { ...diagnosticFlags, ...flags }
  const options = Object.fromEntries(Object.values(definitions).map(key => [key, false]))
  const positionals = []
  for (const arg of args) {
    if (Object.hasOwn(definitions, arg)) options[definitions[arg]] = true
    else positionals.push(arg)
  }
  validate(options)
  if (positionals.length > maxPositionals || positionals.some(arg => arg.startsWith('--'))) throw new Error(usage)
  return { options, positionals }
}

/** Scripts own successful completion; this boundary owns concise failures and exit codes. */
export async function runScriptCli({ title, parseArgs = args => parseScriptArgs(args).options, createUi = createScriptUi, failureMessage = 'Script failed.' }, action, args = process.argv.slice(2)) {
  const verbose = args.some(arg => diagnosticFlags[arg] === 'verbose')
  const ui = createUi({ verbose })
  ui.start(typeof title === 'function' ? title(args) : title)
  try {
    return await action({ ...parseArgs(args), ui })
  } catch (error) {
    process.exitCode = reportScriptError(error, { verbose, ui, failureMessage })
  }
}
