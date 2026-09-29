import { existsSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'
import { createInterface } from 'node:readline/promises'
import { getMigrations, type NewsletterMigrations } from 'better-newsletter/db/migration'
import { loadMigrationConfig } from '../migration/config-loader.js'

export interface BetterNewsletterCliEnvironment {
  readonly cwd: () => string
  readonly stdout: (message: string) => void
  readonly stderr: (message: string) => void
  readonly isInteractive: () => boolean
  readonly confirm: (question: string) => Promise<boolean>
  readonly exists: (path: string) => boolean
  readonly writeFile: (path: string, contents: string) => void
}

const systemEnvironment: BetterNewsletterCliEnvironment = {
  cwd: () => process.cwd(),
  stdout: message => process.stdout.write(message),
  stderr: message => process.stderr.write(message),
  isInteractive: () => process.stdin.isTTY === true && process.stdout.isTTY === true,
  async confirm(question) {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    try {
      const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase()
      return answer === 'y' || answer === 'yes'
    } finally {
      rl.close()
    }
  },
  exists: existsSync,
  writeFile: (path, contents) => writeFileSync(path, contents, 'utf8')
}

interface ParsedArgs {
  readonly command: 'generate' | 'migrate' | 'help'
  readonly cwd: string
  readonly configFile?: string
  readonly output?: string
  readonly yes: boolean
}

const help = `better-newsletter database migrations

Usage:
  better-newsletter generate [options]
  better-newsletter migrate [options]

Commands:
  generate   Inspect the configured database and emit the required SQL.
  migrate    Inspect the configured database and apply the required changes.

Options:
  -c, --cwd <path>      Project working directory.
      --config <path>   Explicit migration config file.
      --output <path>   Generated SQL path (default: schema.sql).
  -y, --yes             Skip confirmation prompts.
  -h, --help            Show this help.
`

function valueAfter(args: readonly string[], index: number, option: string): string {
  const value = args[index + 1]
  if (value == null || value.startsWith('-')) {
    throw new Error(`${option} requires a value.`)
  }
  return value
}

function parseArgs(argv: readonly string[], initialCwd: string): ParsedArgs {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    return { command: 'help', cwd: initialCwd, yes: false }
  }

  const command = argv[0]
  if (command !== 'generate' && command !== 'migrate') {
    throw new Error(`Unknown command: ${command ?? ''}`)
  }

  let cwd = initialCwd
  let configFile: string | undefined
  let output: string | undefined
  let yes = false

  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '-c' || argument === '--cwd') {
      cwd = resolve(initialCwd, valueAfter(argv, index, argument))
      index += 1
    } else if (argument === '--config') {
      configFile = valueAfter(argv, index, argument)
      index += 1
    } else if (argument === '--output') {
      output = valueAfter(argv, index, argument)
      index += 1
    } else if (argument === '-y' || argument === '--yes') {
      yes = true
    } else {
      throw new Error(`Unknown option: ${argument}`)
    }
  }

  if (command === 'migrate' && output != null) {
    throw new Error('--output is only available for generate.')
  }

  return {
    command,
    cwd,
    ...(configFile === undefined ? {} : { configFile }),
    ...(output === undefined ? {} : { output }),
    yes
  }
}

function redactSecrets(message: string): string {
  return message.replace(
    /\b((?:postgres(?:ql)?|mysql):\/\/)[^\s/@]+(?::[^\s/@]*)?@/giu,
    '$1***@'
  )
}

function describePlan(migrations: NewsletterMigrations): string {
  if (migrations.isCurrent) {
    return `Database schema is current (${migrations.dialect}:${migrations.namespace}).\n`
  }
  const lines = [
    `Migration plan (${migrations.dialect}:${migrations.namespace}):`
  ]
  for (const table of migrations.toBeCreated) lines.push(`  create ${table}`)
  for (const item of migrations.toBeAdded) lines.push(`  add ${item}`)
  return `${lines.join('\n')}\n`
}

async function requireConfirmation(
  env: BetterNewsletterCliEnvironment,
  yes: boolean,
  question: string
): Promise<boolean> {
  if (yes) return true
  if (!env.isInteractive()) {
    throw new Error(`${question} Re-run with --yes in a non-interactive environment.`)
  }
  return env.confirm(question)
}

export async function runBetterNewsletterCli(
  argv: readonly string[],
  env: BetterNewsletterCliEnvironment = systemEnvironment
): Promise<number> {
  let parsed: ParsedArgs
  try {
    parsed = parseArgs(argv, env.cwd())
  } catch (error) {
    env.stderr(`${redactSecrets(error instanceof Error ? error.message : String(error))}\n`)
    env.stderr(help)
    return 1
  }

  if (parsed.command === 'help') {
    env.stdout(help)
    return 0
  }

  let loaded: Awaited<ReturnType<typeof loadMigrationConfig>> | undefined
  try {
    loaded = await loadMigrationConfig({
      cwd: parsed.cwd,
      ...(parsed.configFile === undefined ? {} : { configFile: parsed.configFile })
    })
    const migrations = await getMigrations(loaded.config)
    env.stdout(describePlan(migrations))

    if (migrations.isCurrent) return 0

    if (parsed.command === 'generate') {
      const output = resolve(parsed.cwd, parsed.output ?? 'schema.sql')
      const question = env.exists(output)
        ? `Overwrite existing migration file ${output}?`
        : `Generate Better Newsletter migration at ${output}?`
      const write = await requireConfirmation(env, parsed.yes, question)
      if (!write) {
        env.stdout('Migration generation cancelled.\n')
        return 0
      }
      env.writeFile(output, migrations.sql)
      env.stdout(`Wrote migration SQL to ${output}.\n`)
      return 0
    }

    const apply = await requireConfirmation(
      env,
      parsed.yes,
      'Apply this Better Newsletter migration?'
    )
    if (!apply) {
      env.stdout('Migration cancelled; no database changes were applied.\n')
      return 0
    }
    await migrations.runMigrations()
    env.stdout('Better Newsletter migration applied.\n')
    return 0
  } catch (error) {
    env.stderr(`${redactSecrets(error instanceof Error ? error.message : String(error))}\n`)
    return 1
  } finally {
    try {
      await loaded?.config.close?.()
    } catch (error) {
      env.stderr(
        `Failed to close migration resources: ${redactSecrets(
          error instanceof Error ? error.message : String(error)
        )}\n`
      )
    }
  }
}
