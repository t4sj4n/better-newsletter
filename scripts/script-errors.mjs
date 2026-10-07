import { stripVTControlCharacters } from 'node:util'

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
