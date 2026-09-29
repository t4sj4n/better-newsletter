import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  defineBetterNewsletterMigrationConfig,
  getMigrations,
  type MigrationPlan
} from '../src/migration.js'
import {
  runBetterNewsletterCli,
  type BetterNewsletterCliEnvironment
} from '../src/cli/run.js'
import { loadMigrationConfig } from '../src/migration/config-loader.js'

const scratch: string[] = []

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'better-newsletter-migration-'))
  scratch.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of scratch.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('migration API', () => {
  it('exposes one provider plan through the programmatic API', async () => {
    const plan: MigrationPlan = {
      dialect: 'test',
      namespace: 'default',
      toBeCreated: ['newsletter_contacts'],
      toBeAdded: ['index:newsletter_contacts_email_idx'],
      statements: ['CREATE TABLE newsletter_contacts (id text)'],
      sql: 'CREATE TABLE newsletter_contacts (id text);\n',
      isCurrent: false
    }
    let applied: MigrationPlan | undefined
    const config = defineBetterNewsletterMigrationConfig({
      provider: {
        dialect: 'test',
        async plan() {
          return plan
        },
        async apply(next) {
          applied = next
        }
      }
    })

    const migrations = await getMigrations(config)
    expect(migrations).toMatchObject({
      dialect: 'test',
      namespace: 'default',
      toBeCreated: ['newsletter_contacts'],
      isCurrent: false
    })
    await migrations.runMigrations()
    expect(applied).toBe(plan)
  })

  it('does not call the provider for an already-current plan', async () => {
    let applied = false
    const config = defineBetterNewsletterMigrationConfig({
      provider: {
        dialect: 'test',
        async plan(): Promise<MigrationPlan> {
          return {
            dialect: 'test',
            namespace: 'default',
            toBeCreated: [],
            toBeAdded: [],
            statements: [],
            sql: '',
            isCurrent: true
          }
        },
        async apply() {
          applied = true
        }
      }
    })

    await (await getMigrations(config)).runMigrations()
    expect(applied).toBe(false)
  })
})

describe('migration config loading and CLI', () => {
  function writeConfig(directory: string): void {
    writeFileSync(join(directory, 'better-newsletter.config.ts'), `
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = ${JSON.stringify(directory)}

export const migration = {
  provider: {
    dialect: 'fixture',
    async plan() {
      return {
        dialect: 'fixture',
        namespace: 'test',
        toBeCreated: ['newsletter_fixture'],
        toBeAdded: [],
        statements: ['CREATE TABLE newsletter_fixture (id text)'],
        sql: 'CREATE TABLE newsletter_fixture (id text);\\n',
        isCurrent: false
      } as const
    },
    async apply() {
      writeFileSync(join(root, 'applied.txt'), 'yes', 'utf8')
    }
  },
  async close() {
    writeFileSync(join(root, 'closed.txt'), 'yes', 'utf8')
  }
} satisfies {
  provider: {
    dialect: string
    plan(): Promise<unknown>
    apply(plan: unknown): Promise<void>
  }
  close(): Promise<void>
}
`, 'utf8')
  }

  function environment(
    directory: string,
    options: { interactive?: boolean; confirm?: boolean } = {}
  ): { env: BetterNewsletterCliEnvironment; stdout: string[]; stderr: string[] } {
    const stdout: string[] = []
    const stderr: string[] = []
    return {
      stdout,
      stderr,
      env: {
        cwd: () => directory,
        stdout: message => stdout.push(message),
        stderr: message => stderr.push(message),
        isInteractive: () => options.interactive ?? false,
        confirm: async () => options.confirm ?? false,
        exists: existsSync,
        writeFile: (path, contents) => writeFileSync(path, contents, 'utf8')
      }
    }
  }

  it('loads a TypeScript named migration export without invoking runtime newsletter config', async () => {
    const directory = tempDirectory()
    writeConfig(directory)

    const loaded = await loadMigrationConfig({ cwd: directory })
    expect(loaded.path).toBe(join(directory, 'better-newsletter.config.ts'))
    expect(loaded.config.provider.dialect).toBe('fixture')
    await loaded.config.close?.()
    expect(readFileSync(join(directory, 'closed.txt'), 'utf8')).toBe('yes')
  })

  it('generates inspectable SQL to a host-owned file', async () => {
    const directory = tempDirectory()
    writeConfig(directory)
    const { env, stdout, stderr } = environment(directory)

    await expect(runBetterNewsletterCli([
      'generate',
      '--output',
      'migration.sql',
      '--yes'
    ], env)).resolves.toBe(0)

    expect(stderr).toEqual([])
    expect(readFileSync(join(directory, 'migration.sql'), 'utf8'))
      .toBe('CREATE TABLE newsletter_fixture (id text);\n')
    expect(stdout.join('')).toContain('create newsletter_fixture')
    expect(existsSync(join(directory, 'applied.txt'))).toBe(false)
    expect(existsSync(join(directory, 'closed.txt'))).toBe(true)
  })

  it('does not migrate non-interactively without --yes', async () => {
    const directory = tempDirectory()
    writeConfig(directory)
    const { env, stderr } = environment(directory)

    await expect(runBetterNewsletterCli(['migrate'], env)).resolves.toBe(1)
    expect(stderr.join('')).toContain('Re-run with --yes')
    expect(existsSync(join(directory, 'applied.txt'))).toBe(false)
  })

  it('honors an interactive decline without applying changes', async () => {
    const directory = tempDirectory()
    writeConfig(directory)
    const { env, stdout } = environment(directory, {
      interactive: true,
      confirm: false
    })

    await expect(runBetterNewsletterCli(['migrate'], env)).resolves.toBe(0)
    expect(stdout.join('')).toContain('no database changes were applied')
    expect(existsSync(join(directory, 'applied.txt'))).toBe(false)
  })

  it('applies migrations with --yes and closes host resources', async () => {
    const directory = tempDirectory()
    writeConfig(directory)
    const { env, stderr } = environment(directory)

    await expect(runBetterNewsletterCli(['migrate', '--yes'], env)).resolves.toBe(0)
    expect(stderr).toEqual([])
    expect(readFileSync(join(directory, 'applied.txt'), 'utf8')).toBe('yes')
    expect(readFileSync(join(directory, 'closed.txt'), 'utf8')).toBe('yes')
  })

  it('requires explicit overwrite approval for an existing generated file', async () => {
    const directory = tempDirectory()
    writeConfig(directory)
    writeFileSync(join(directory, 'migration.sql'), 'keep-me', 'utf8')
    const { env } = environment(directory, { interactive: true, confirm: false })

    await expect(runBetterNewsletterCli([
      'generate',
      '--output',
      'migration.sql'
    ], env)).resolves.toBe(0)

    expect(readFileSync(join(directory, 'migration.sql'), 'utf8')).toBe('keep-me')
  })
})
