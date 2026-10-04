import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { POSTGRES_NEWSLETTER_SCHEMA, renderPostgresSchemaSql } from '../packages/better-newsletter/src/migration/postgres-schema.js'

it('requires deliberate PostgreSQL target revision handling when the canonical schema changes', () => {
  const approved: unknown = JSON.parse(readFileSync(new URL('./fixtures/postgres-schema-revision.json', import.meta.url), 'utf8'))
  expect({
    revision: POSTGRES_NEWSLETTER_SCHEMA.revision,
    sha256: createHash('sha256').update(renderPostgresSchemaSql()).digest('hex')
  }, 'Canonical PostgreSQL target changed. Decide whether its dialect-specific schema revision must be incremented, document any migration requirement, and deliberately update test/fixtures/postgres-schema-revision.json. Regenerating the SQL snapshot alone must not accept a target revision change.').toEqual(approved)
})
