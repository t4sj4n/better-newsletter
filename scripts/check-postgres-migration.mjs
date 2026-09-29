import console from 'node:console'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { renderPostgresSchemaSql } from '../dist/migration/postgres-schema.js'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const path = join(root, 'migrations/postgres/001_newsletter.sql')
const expected = renderPostgresSchemaSql()

if (process.argv.includes('--write')) {
  writeFileSync(path, expected, 'utf8')
  console.log('Updated migrations/postgres/001_newsletter.sql from the canonical schema.')
  process.exit(0)
}

const actual = readFileSync(path, 'utf8')
if (actual !== expected) {
  throw new Error(
    'migrations/postgres/001_newsletter.sql has drifted from the canonical schema. '
    + 'Run pnpm migration:snapshot:write after changing the schema model.'
  )
}

console.log('PostgreSQL migration snapshot matches the canonical schema.')
