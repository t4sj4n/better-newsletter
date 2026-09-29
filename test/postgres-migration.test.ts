import { readFileSync } from 'node:fs'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getMigrations } from '../src/migration.js'
import { postgresMigration } from '../src/postgres.js'
import { renderPostgresSchemaSql } from '../src/migration/postgres-schema.js'

const databaseUrl = process.env.DATABASE_URL

describe.skipIf(!databaseUrl)('PostgreSQL migration tooling', () => {
  const admin = new Pool({ connectionString: databaseUrl, max: 4 })
  const schemas = new Set<string>()

  function schemaName(label: string): string {
    const schema = `newsletter_migration_${label}_${crypto.randomUUID().replaceAll('-', '')}`
    schemas.add(schema)
    return schema
  }

  async function createSchema(label: string): Promise<string> {
    const schema = schemaName(label)
    await admin.query(`CREATE SCHEMA "${schema}"`)
    return schema
  }

  function database(schema: string) {
    const pool = new Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schema}`,
      max: 5
    })
    const db = new Kysely<Record<string, never>>({
      dialect: new PostgresDialect({ pool })
    })
    return { db, pool }
  }

  async function tables(schema: string): Promise<string[]> {
    const result = await admin.query<{ table_name: string }>(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = $1 AND table_type = 'BASE TABLE'
       ORDER BY table_name`,
      [schema]
    )
    return result.rows.map(row => row.table_name)
  }

  beforeAll(async () => {
    await admin.query('SELECT 1')
  })

  afterAll(async () => {
    for (const schema of schemas) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    }
    await admin.end()
  })

  it('plans an empty database, applies it transactionally, then becomes a no-op', async () => {
    const schema = await createSchema('empty')
    const { db } = database(schema)
    try {
      const config = { provider: postgresMigration(db, { schema }) }
      const migrations = await getMigrations(config)

      expect(migrations.dialect).toBe('postgres')
      expect(migrations.namespace).toBe(schema)
      expect(migrations.toBeCreated).toEqual([
        'newsletter_contacts',
        'newsletter_subscriptions',
        'newsletter_tokens',
        'newsletter_events',
        'newsletter_rate_limits'
      ])
      expect(migrations.sql).toContain(`SET search_path TO "${schema}", pg_catalog;`)
      expect(migrations.sql).toContain('CREATE TABLE newsletter_contacts')
      expect(migrations.isCurrent).toBe(false)

      await migrations.runMigrations()
      expect(await tables(schema)).toEqual([
        'newsletter_contacts',
        'newsletter_events',
        'newsletter_rate_limits',
        'newsletter_subscriptions',
        'newsletter_tokens'
      ])

      const current = await getMigrations(config)
      expect(current.isCurrent).toBe(true)
      expect(current.statements).toEqual([])
      expect(current.sql).toBe('')
    } finally {
      await db.destroy()
    }
  })

  it('treats the packaged generated PostgreSQL snapshot as the same target schema', async () => {
    const schema = await createSchema('snapshot')
    const { db, pool } = database(schema)
    try {
      const snapshot = readFileSync(
        new URL('../migrations/postgres/001_newsletter.sql', import.meta.url),
        'utf8'
      )
      expect(snapshot).toBe(renderPostgresSchemaSql())

      await pool.query(snapshot)
      const migrations = await getMigrations({
        provider: postgresMigration(db, { schema })
      })
      expect(migrations.isCurrent).toBe(true)
    } finally {
      await db.destroy()
    }
  })

  it('generates only missing additive changes for a partially initialized schema', async () => {
    const schema = await createSchema('partial')
    const { db, pool } = database(schema)
    try {
      await pool.query(`
        CREATE TABLE newsletter_contacts (
          id text CONSTRAINT newsletter_contacts_pkey PRIMARY KEY,
          email text NOT NULL CONSTRAINT newsletter_contacts_email_key UNIQUE
        )
      `)
      await pool.query('CREATE TABLE host_owned_table (id text PRIMARY KEY)')

      const migrations = await getMigrations({
        provider: postgresMigration(db, { schema })
      })

      expect(migrations.toBeCreated).not.toContain('newsletter_contacts')
      expect(migrations.toBeCreated).toContain('newsletter_subscriptions')
      expect(migrations.toBeAdded).toContain('newsletter_contacts.capability_generation')
      expect(migrations.toBeAdded).toContain('constraint:newsletter_contacts_email_check')
      expect(migrations.sql).not.toContain('DROP TABLE')
      expect(migrations.sql).not.toContain('DROP COLUMN')

      await migrations.runMigrations()
      expect((await tables(schema))).toContain('host_owned_table')
      expect((await getMigrations({
        provider: postgresMigration(db, { schema })
      })).isCurrent).toBe(true)
    } finally {
      await db.destroy()
    }
  })

  it('preserves unrelated host columns while bringing Better Newsletter objects current', async () => {
    const schema = await createSchema('host_columns')
    const { db, pool } = database(schema)
    try {
      await pool.query(`
        CREATE TABLE newsletter_contacts (
          id text NOT NULL,
          host_owned_note text,
          capability_generation bigint NOT NULL DEFAULT 1,
          email text NOT NULL,
          status text NOT NULL,
          subject_namespace text,
          subject_id text,
          metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
          suppressed_at timestamptz,
          suppression_reason text,
          created_at timestamptz NOT NULL,
          updated_at timestamptz NOT NULL,
          CONSTRAINT newsletter_contacts_pkey PRIMARY KEY (id),
          CONSTRAINT newsletter_contacts_capability_generation_check CHECK (capability_generation > 0),
          CONSTRAINT newsletter_contacts_email_key UNIQUE (email),
          CONSTRAINT newsletter_contacts_email_check CHECK (email = lower(btrim(email)) AND length(email) BETWEEN 1 AND 254),
          CONSTRAINT newsletter_contacts_status_check CHECK (status IN ('ENABLED', 'SUPPRESSED')),
          CONSTRAINT newsletter_contacts_metadata_check CHECK (jsonb_typeof(metadata) = 'object'),
          CONSTRAINT newsletter_contacts_subject_pair CHECK (
            (subject_namespace IS NULL AND subject_id IS NULL)
            OR (subject_namespace IS NOT NULL AND subject_id IS NOT NULL)
          )
        )
      `)

      const migrations = await getMigrations({
        provider: postgresMigration(db, { schema })
      })
      expect(migrations.sql).not.toContain('host_owned_note')
      await migrations.runMigrations()

      const column = await pool.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = 'newsletter_contacts'
           AND column_name = 'host_owned_note'`,
        [schema]
      )
      expect(column.rows).toHaveLength(1)
    } finally {
      await db.destroy()
    }
  })

  it('supports an explicit non-default schema even when the connection search_path differs', async () => {
    const schema = await createSchema('explicit')
    const { db } = database('public')
    try {
      const migrations = await getMigrations({
        provider: postgresMigration(db, { schema })
      })
      await migrations.runMigrations()
      expect(await tables(schema)).toHaveLength(5)
    } finally {
      await db.destroy()
    }
  })

  it('generated SQL and direct migration converge to the same current target', async () => {
    const generatedSchema = await createSchema('generated')
    const directSchema = await createSchema('direct')
    const generated = database(generatedSchema)
    const direct = database(directSchema)

    try {
      const generatedPlan = await getMigrations({
        provider: postgresMigration(generated.db, { schema: generatedSchema })
      })
      await generated.pool.query(generatedPlan.sql)

      const directPlan = await getMigrations({
        provider: postgresMigration(direct.db, { schema: directSchema })
      })
      await directPlan.runMigrations()

      expect((await getMigrations({
        provider: postgresMigration(generated.db, { schema: generatedSchema })
      })).isCurrent).toBe(true)
      expect((await getMigrations({
        provider: postgresMigration(direct.db, { schema: directSchema })
      })).isCurrent).toBe(true)
      expect(await tables(generatedSchema)).toEqual(await tables(directSchema))
    } finally {
      await generated.db.destroy()
      await direct.db.destroy()
    }
  })

  it('rolls back the complete direct migration when one statement fails', async () => {
    const schema = await createSchema('rollback')
    const { db } = database(schema)
    const provider = postgresMigration(db, { schema })
    try {
      await expect(provider.apply({
        dialect: 'postgres',
        namespace: schema,
        toBeCreated: ['transaction_probe'],
        toBeAdded: [],
        statements: [
          'CREATE TABLE transaction_probe (id text)',
          'THIS IS NOT VALID SQL'
        ],
        sql: '',
        isCurrent: false
      })).rejects.toThrow()

      expect(await tables(schema)).not.toContain('transaction_probe')
    } finally {
      await db.destroy()
    }
  })
})
