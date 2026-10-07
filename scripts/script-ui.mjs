import console from 'node:console'
import { performance } from 'node:perf_hooks'
import process from 'node:process'
import { Writable } from 'node:stream'
import { stripVTControlCharacters } from 'node:util'
import { cancel, intro, isCancel, isCI, log, note, outro, S_BAR, spinner, taskLog } from '@clack/prompts'
import picocolors from 'picocolors'
import { checkedResult, liveCommandRunner } from './script-core.mjs'

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

export function formatDuration(milliseconds) {
  const duration = Math.max(0, milliseconds)
  if (duration < 1000) return `${Math.round(duration)}ms`
  const seconds = Math.round(duration / 100) / 10
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const totalSeconds = Math.round(duration / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor(totalSeconds / 60) % 60
  return `${hours ? `${hours}h ` : ''}${minutes}m ${totalSeconds % 60}s`
}

// Wrap before Clack adds its three-column guide, so terminals never wrap at column zero.
// Strip subprocess terminal controls: Clack owns the cursor and its own status colors.
function wrapMessage(message, columns = 80) {
  const width = Math.max(1, columns - 4)
  return stripVTControlCharacters(String(message)).replaceAll('\t', '    ').split('\n').flatMap(line => {
    const lines = []
    let current = ''
    let used = 0
    let lastSpace
    for (const { segment } of graphemes.segment(line)) {
      const wide = /[\u1100-\u115F\u2329\u232A\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE10-\uFE19\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]|\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(segment)
        || segment.includes('\u20E3')
      // taskLog also counts code units when erasing rows; keep both counts within the width.
      const size = Math.max(segment.length, wide ? 2 : 1)
      if (used + size > width && segment === ' ') {
        lines.push(current)
        current = ''
        used = 0
        lastSpace = undefined
        continue
      }
      while (used + size > width && current) {
        if (lastSpace?.position > 0) {
          lines.push(current.slice(0, lastSpace.position))
          current = current.slice(lastSpace.position + 1)
          used -= lastSpace.width + 1
        } else {
          lines.push(current)
          current = ''
          used = 0
        }
        lastSpace = undefined
      }
      if (segment === ' ') lastSpace = { position: current.length, width: used }
      current += segment
      used += size
    }
    lines.push(current)
    return lines
  }).join('\n')
}

/** Let taskLog own the body while Clack's spinner updates the heading and elapsed time. */
function commandProgress({ output, heading, command, verbose, color }) {
  let row = 0
  const verticalMoves = new RegExp(`${String.fromCharCode(27)}\\[(\\d*)[AB]|\\n`, 'gu')
  const logs = new Writable({
    write(chunk, encoding, callback) {
      const value = chunk.toString()
      // Lines are already wrapped. Track only the vertical moves emitted by taskLog.
      for (const match of value.matchAll(verticalMoves)) {
        if (match[0] === '\n') row++
        else row += (Number(match[1]) || 1) * (match[0].endsWith('A') ? -1 : 1)
      }
      output.write(chunk)
      callback()
    }
  })
  logs.isTTY = true
  logs.columns = output.columns || Number(process.env.COLUMNS) || 80
  const progress = taskLog({ output: logs, title: heading(), spacing: 0, retainLog: verbose,
    limit: Math.max(8, command.split('\n').length) })
  // Keep the command visible in its own group while the live output rolls beneath it.
  progress.message(command)
  const messages = progress.group('')
  const paint = frame => {
    const distance = row - 1
    output.write(`\u001b[${distance}A\u001b[1G\u001b[2K${color.magenta(frame)}  ${heading()}\u001b[${distance}B\u001b[1G`)
  }
  const animation = new Writable({
    write(chunk, encoding, callback) {
      const value = chunk.toString()
      // Keep Clack's cursor visibility handling; its separate spinner row stays virtual.
      if (value === '\u001b[?25l' || value === '\u001b[?25h') output.write(chunk)
      callback()
    }
  })
  animation.isTTY = true
  animation.columns = logs.columns
  const activity = spinner({ output: animation, withGuide: false, styleFrame: frame => {
    paint(frame)
    return frame
  } })
  paint('◒')
  activity.start()
  return { progress, activity, message: message => messages.message(message) }
}

export class ScriptCancelled extends Error {
  constructor(message = 'Script cancelled.') {
    super(message)
    this.exitCode = 130
  }
}

// Remove Node stack frames and source pointers from subprocess failures too.
// Full output remains available through --verbose/--debug.
export function conciseMessage(message) {
  const cleaned = stripVTControlCharacters(String(message))
    .replace(/^(?:file:\/\/[^\n]+|\/[^\n]+:\d+(?::\d+)?)\n[\s\S]*?\n(?=\w*Error:)/gmu, '')
  const lines = cleaned.split('\n').filter(line =>
    !/^\s*at\s/u.test(line)
    && !/^(?:file:\/\/|Node\.js v|\s*\^+\s*$)/u.test(line)
    && !/^\s*\[cause\]:/u.test(line)
    && !/^\s*\.\.\. \d+ lines matching (?:cause )?stack trace/u.test(line)
    && !/^\s*(?:[❯>]\s*)?\d+\|/u.test(line)
    && !/^\s*\|\s*\^+/u.test(line)
  )
  return (lines.length > 16 ? [...lines.slice(0, 8), '… (use --verbose for full output)', ...lines.slice(-8)] : lines).join('\n').trim()
}

function commandFailureMessage(error) {
  const result = error?.commandResult
  if (!result || !(result.command === 'vitest' || result.args.includes('vitest'))) {
    return conciseMessage(error?.message ?? error)
  }
  // Vitest puts expected test logs on stderr too. Prefer its actual failure reports.
  const output = stripVTControlCharacters(`${result.stderr ?? ''}\n${result.stdout ?? ''}`)
  const failures = [...output.matchAll(/^[ \t]*FAIL[ \t]+(.+)$/gmu)]
  if (!failures.length) return conciseMessage(error.message)
  const details = failures.slice(0, 3).map((failure, index) => {
    const block = output.slice(failure.index + failure[0].length, failures[index + 1]?.index)
    const diagnostic = block.search(/^\s*(?:❯|Serialized Error:|[⎯─━-]{3,}|Test Files\s|Tests\s|Start at\s|Duration\s)/mu)
    const reason = conciseMessage(diagnostic < 0 ? block : block.slice(0, diagnostic)).split('\n')
    return [`FAIL ${failure[1]}`, ...reason.slice(0, 8),
      ...(reason.length > 8 ? ['… (use --verbose for full output)'] : [])].join('\n')
  })
  if (failures.length > 3) details.push(`${failures.length - 3} more failed tests/suites (use --verbose for full output).`)
  return `Vitest failed (exit ${result.status}):\n${details.join('\n\n')}`
}

function errorTree(error, seen = new Set()) {
  if (seen.has(error)) return []
  seen.add(error)
  const children = error instanceof AggregateError ? error.errors : error?.cause ? [error.cause] : []
  return [error, ...children.flatMap(child => errorTree(child, seen))]
}

export function reportScriptError(error, { verbose = false, ui = createScriptUi(), failureMessage = 'Script failed.' } = {}) {
  if (error instanceof ScriptCancelled) {
    ui.cancel(error.message)
    return error.exitCode
  }
  const errors = errorTree(error)
  // AggregateError's first member is the release failure; later members are cleanup failures.
  let root = error
  const seen = new Set()
  while (!seen.has(root)) {
    seen.add(root)
    const next = root instanceof AggregateError ? root.errors[0] : root?.cause
    if (!next || seen.has(next)) break
    root = next
  }
  ui.error(commandFailureMessage(root))
  for (const context of errors.filter(item => item !== root)) {
    ui.warn(conciseMessage(context?.message ?? context))
  }
  if (verbose) {
    console.error(error)
    if (root?.commandResult?.stderr && root.commandResult.stdout) console.error(`Command stdout:\n${root.commandResult.stdout}`)
  } else ui.info('Run again with --verbose or --debug for diagnostic details.')
  ui.finish(failureMessage)
  return errors.find(item => Number.isInteger(item?.exitCode) && item.exitCode > 0 && item.exitCode < 256)?.exitCode ?? 1
}

export function createScriptUi({ name = 'better-newsletter', operation = 'Script', Cancelled = ScriptCancelled, enabled = true, verbose = false, output = process.stdout, now = () => performance.now() } = {}) {
  const opts = { output }
  const format = message => wrapMessage(message, output.columns || Number(process.env.COLUMNS) || 80)
  const guided = message => format(message).split('\n').join(`\n${S_BAR}  `)
  const compact = (message, extraPadding = 0) => {
    const lines = wrapMessage(message, (output.columns || Number(process.env.COLUMNS) || 80) - 1 - extraPadding).split('\n')
    return lines.length > 1 ? `${lines[0]}…` : lines[0]
  }
  const color = picocolors.createColors(Boolean(process.env.NO_COLOR === undefined && process.env.FORCE_COLOR !== '0'
    && (output.isTTY && process.env.TERM !== 'dumb' || process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0')))
  let startedAt = now()
  let finishedAt
  let promptWait = 0
  let promptStartedAt = 0
  let promptDepth = 0
  let prompts = 0
  const steps = []
  const elapsed = start => Math.max(0, now() - start)
  const timed = (label, duration) => format(`${label} (${formatDuration(duration)})`)
  const heading = (label, start, padding = 0) => {
    const duration = `(${formatDuration(elapsed(start))})`
    return `${compact(label, duration.length + 1 + padding)} ${color.dim(duration)}`
  }
  const record = (label, start, kind, status) => {
    const duration = elapsed(start)
    steps.push({ label, duration, kind, status })
    return duration
  }
  const preview = (message, title) => {
    if (!enabled) return
    log.step(format(title), opts)
    log.message(format(message), { ...opts, spacing: 0 })
  }
  const summary = () => {
    if (finishedAt !== undefined) return
    finishedAt = now()
    const total = Math.max(0, finishedAt - startedAt)
    const wait = Math.min(total, promptWait + (promptDepth ? Math.max(0, finishedAt - promptStartedAt) : 0))
    const count = status => steps.filter(step => step.status === status).length
    const slowest = [...steps].sort((a, b) => b.duration - a.duration).slice(0, 3)
    const message = [
      `Total          ${formatDuration(total)}`,
      `Execution      ${formatDuration(total - wait)} (excluding prompts)`,
      `Prompt wait    ${formatDuration(wait)} (${prompts} ${prompts === 1 ? 'prompt' : 'prompts'})`,
      `Steps          ${count('completed')} completed · ${count('failed')} failed · ${count('cancelled')} cancelled`,
      `Commands       ${steps.filter(step => step.kind === 'command').length}`,
      ...(slowest.length ? ['', 'Slowest steps', ...slowest.map(step =>
        `${step.label} · ${formatDuration(step.duration)}${step.status === 'completed' ? '' : ` (${step.status})`}`)] : [])
    ].join('\n')
    if (enabled) note(wrapMessage(message, (output.columns || Number(process.env.COLUMNS) || 80) - 3),
      compact('Run summary', 2), { ...opts, format: value => value })
  }
  return {
    start(label) {
      startedAt = now()
      finishedAt = undefined
      promptWait = 0
      prompts = 0
      steps.length = 0
      const title = guided(`${name} · ${label}`)
      if (enabled) intro(color.inverse(title), opts)
    },
    note(message, title) { if (enabled) note(message, title, opts) },
    preview,
    info(message) { if (enabled) log.info(format(message), opts) },
    success(message) { if (enabled) log.success(format(message), opts) },
    warn(message) { if (enabled) log.warn(format(message), opts) },
    error(message) { if (enabled) log.error(format(message), opts) },
    cancel(message) {
      summary()
      if (enabled) cancel(guided(message), opts)
    },
    async input(action) {
      if (promptDepth++ === 0) {
        promptStartedAt = now()
        prompts++
      }
      try {
        const value = await action()
        if (isCancel(value)) throw new Cancelled()
        return value
      } finally {
        if (--promptDepth === 0) promptWait += elapsed(promptStartedAt)
      }
    },
    async step(label, action) {
      const start = now()
      let progress
      if (enabled && output.isTTY && !isCI()) {
        progress = spinner({ ...opts, styleFrame: frame => {
          progress.message(heading(label, start, 3))
          return color.magenta(frame)
        } })
        progress.start(heading(label, start, 3))
      } else if (enabled) {
        log.step(format(label), opts)
      }
      try {
        const result = await action()
        if (progress?.isCancelled) throw new Cancelled(`${operation} cancelled during the current step.`)
        progress?.clear()
        const duration = record(label, start, 'step', 'completed')
        if (enabled) log.success(timed(label, duration), { ...opts, spacing: progress ? 0 : 1 })
        return result
      } catch (error) {
        progress?.clear()
        const status = error instanceof ScriptCancelled ? 'cancelled' : 'failed'
        const duration = record(label, start, 'step', status)
        if (enabled && status !== 'cancelled') log.error(timed(`${label} failed`, duration), { ...opts, spacing: progress ? 0 : 1 })
        throw error
      }
    },
    async command(run, command, args, { label = 'Running command', completed = 'Command completed', ...options } = {}) {
      const start = now()
      const commandText = format(`$ ${command} ${args.join(' ')}`)
      // npm requires both stdin and stdout to be TTYs for browser/OTP authentication.
      const live = enabled && !options.interactive && output.isTTY && !isCI()
        ? commandProgress({ output, heading: () => heading(label, start), command: commandText, verbose, color }) : undefined
      if (enabled && !live) {
        log.step(format(label), opts)
        log.message(commandText.split('\n').map(color.dim), { ...opts, spacing: 0 })
      }
      try {
        const result = await run(command, args, {
          ...options, onOutput: line => {
            const message = verbose ? line : conciseMessage(line)
            if (message && enabled) {
              if (live) live.message(format(message))
              else log.message(format(message).split('\n').map(color.dim), { ...opts, spacing: 0 })
            }
          }
        })
        live?.activity.clear()
        if (live?.activity.isCancelled) throw new Cancelled(`${operation} cancelled during the current command.`)
        const stdout = checkedResult(result, command, args)
        const duration = record(label, start, 'command', 'completed')
        if (live) live.progress.success(timed(completed, duration), { showLog: verbose })
        else if (enabled) log.success(timed(completed, duration), opts)
        return stdout
      } catch (error) {
        live?.activity.clear()
        const status = error instanceof ScriptCancelled ? 'cancelled' : 'failed'
        const duration = record(label, start, 'command', status)
        const message = timed(`${label} ${status}`, duration)
        if (live) live.progress.error(message, { showLog: verbose })
        else if (enabled) log.error(message, opts)
        throw error
      }
    },
    finish(message) {
      summary()
      if (enabled) outro(guided(message), opts)
    }
  }
}

export function scriptCommand(cwd, run, ui) {
  const live = run ?? liveCommandRunner(cwd)
  return (command, args, options) => ui.command(live, command, args, options)
}
