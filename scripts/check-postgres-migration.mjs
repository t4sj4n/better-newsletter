import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runScriptCli } from './script-cli.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const path = join(root, 'packages/better-newsletter/migrations/postgres/001_newsletter.sql')

await runScriptCli({
  title: 'migration snapshot',
  parseArgs: args => ({ write: args.includes('--write') })
}, async ({ write, ui }) => {
  await ui.step(write ? 'Writing migration snapshot' : 'Checking migration snapshot', async () => {
    const { renderPostgresSchemaSnapshot } = await import('../packages/better-newsletter/dist/migration/postgres-schema.js')
    const expected = renderPostgresSchemaSnapshot()
    if (write) {
      writeFileSync(path, expected, 'utf8')
      return
    }
    const actual = readFileSync(path, 'utf8')
    if (actual !== expected) {
      throw new Error(
        'packages/better-newsletter/migrations/postgres/001_newsletter.sql has drifted from the canonical schema. '
        + 'Run pnpm migration:snapshot:write after changing the schema model.'
      )
    }
  })
  ui.finish(write
    ? 'Updated packages/better-newsletter/migrations/postgres/001_newsletter.sql from the canonical schema.'
    : 'PostgreSQL migration snapshot matches the canonical schema.')
})
