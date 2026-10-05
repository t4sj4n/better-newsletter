import console from 'node:console'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { renderPostgresSchemaSnapshot } from '../packages/better-newsletter/dist/migration/postgres-schema.js'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const path = join(root, 'packages/better-newsletter/migrations/postgres/001_newsletter.sql')
const expected = renderPostgresSchemaSnapshot()

if (process.argv.includes('--write')) {
  writeFileSync(path, expected, 'utf8')
  console.log('Updated packages/better-newsletter/migrations/postgres/001_newsletter.sql from the canonical schema.')
  process.exit(0)
}

const actual = readFileSync(path, 'utf8')
if (actual !== expected) {
  throw new Error(
    'packages/better-newsletter/migrations/postgres/001_newsletter.sql has drifted from the canonical schema. '
    + 'Run pnpm migration:snapshot:write after changing the schema model.'
  )
}

console.log('PostgreSQL migration snapshot matches the canonical schema.')
