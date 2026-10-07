import { Buffer } from 'node:buffer'
import { execFileSync, spawn } from 'node:child_process'
import { constants } from 'node:os'
import { createInterface } from 'node:readline'
import process from 'node:process'

function commandExitCode(error) {
  return error.signal ? 128 + (constants.signals[error.signal] ?? 0) : error.status ?? error.code
}

/** Stream subprocess output without blocking Clack's rendering. */
export function liveCommandRunner(cwd) {
  return (command, args, { input, onOutput, interactive = false, maxBuffer = 16 * 1024 * 1024, ...options } = {}) => new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd, ...options, stdio: interactive ? 'inherit' : ['pipe', 'pipe', 'pipe']
    })
    const output = { stdout: '', stderr: '' }
    let failure
    for (const name of ['stdout', 'stderr']) {
      const stream = child[name]
      if (!stream) continue
      let bytes = 0
      stream.setEncoding('utf8')
      stream.on('data', chunk => {
        bytes += Buffer.byteLength(chunk)
        if (bytes > maxBuffer) {
          failure ??= new Error(`${command} ${name} exceeded the ${maxBuffer}-byte output limit.`)
          child.kill()
        } else output[name] += chunk
      })
      createInterface({ input: stream, crlfDelay: Infinity }).on('line', line => onOutput?.(line))
    }
    child.on('error', error => {
      failure = new Error(`Cannot run ${command}. Install/authenticate it before retrying.`, { cause: error })
    })
    child.on('close', (code, signal) => {
      if (failure) reject(failure)
      else resolve({ status: commandExitCode({ status: code, signal }), ...output })
    })
    // A command may exit before consuming its input (for example, failed authentication).
    if (child.stdin) {
      child.stdin.on('error', () => {})
      child.stdin.end(input)
    }
  })
}

export function commandRunner(cwd) {
  return (command, args, options = {}) => {
    try {
      return { status: 0, stdout: execFileSync(command, args, {
        cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'], ...options
      }) ?? '', stderr: '' }
    } catch (error) {
      const status = commandExitCode(error)
      if (typeof status !== 'number') {
        throw new Error(`Cannot run ${command}. Install/authenticate it before retrying.`, { cause: error })
      }
      return { status, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') }
    }
  }
}

export async function checked(run, command, args, options) {
  return checkedResult(await run(command, args, options), command, args)
}

export function checkedResult(result, command, args) {
  if (result.status !== 0) {
    const error = new Error(`${command} ${args.join(' ')} failed:\n${result.stderr || result.stdout}`)
    error.exitCode = result.status
    // Preserve both streams for presentation without changing command failure semantics.
    Object.defineProperty(error, 'commandResult', { value: { command, args: [...args], ...result } })
    throw error
  }
  return result.stdout.trimEnd()
}

/** Execute shared command definitions in order, stopping at the first failure. */
export async function runScriptChecks(checks, execute) {
  for (const { command, args, env, ...options } of checks) {
    await execute(command, args, { ...options, ...(env ? { env: { ...process.env, ...env } } : {}) })
  }
}
