import { sql, type Kysely } from 'kysely'
import { BETTER_NEWSLETTER_VERSION } from './runtime-version.js'
import type { MigrationPlan, MigrationProvider } from '../migration.js'
import {
  POSTGRES_NEWSLETTER_SCHEMA,
  renderPostgresAddColumn,
  renderPostgresAddConstraint,
  renderPostgresCreateIndex,
  renderPostgresCreateTable
} from './postgres-schema.js'

export interface PostgresMigrationOptions {
  /** PostgreSQL schema containing the Better Newsletter tables. Defaults to current_schema(). */
  readonly schema?: string
}

interface PostgresSchemaState {
  readonly tables: ReadonlySet<string>
  readonly columns: ReadonlyMap<string, ReadonlySet<string>>
  readonly constraints: ReadonlyMap<string, ReadonlySet<string>>
  readonly indexes: ReadonlySet<string>
}

function quoteIdentifier(value: string): string {
  if (!value || value.includes('\u0000')) {
    throw new Error('PostgreSQL schema names must be non-empty identifiers.')
  }
  return `"${value.replaceAll('"', '""')}"`
}

async function resolveSchema<DB>(
  db: Kysely<DB>,
  configured?: string
): Promise<string> {
  const schema = configured ?? (await sql<{ schema: string | null }>`
    SELECT current_schema() AS schema
  `.execute(db)).rows[0]?.schema

  if (schema == null || schema.length === 0) {
    throw new Error('Could not resolve a PostgreSQL schema for Better Newsletter migrations.')
  }

  const exists = (await sql<{ exists: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM pg_namespace WHERE nspname = ${schema}
    ) AS exists
  `.execute(db)).rows[0]?.exists === true

  if (!exists) {
    throw new Error(`PostgreSQL schema "${schema}" does not exist.`)
  }
  return schema
}

function addToMap(
  map: Map<string, Set<string>>,
  key: string,
  value: string
): void {
  const values = map.get(key) ?? new Set<string>()
  values.add(value)
  map.set(key, values)
}

async function inspectPostgresSchema<DB>(
  db: Kysely<DB>,
  schema: string
): Promise<PostgresSchemaState> {
  const [tablesResult, columnsResult, constraintsResult, indexesResult] = await Promise.all([
    sql<{ table_name: string }>`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = ${schema} AND table_type = 'BASE TABLE'
    `.execute(db),
    sql<{ table_name: string; column_name: string }>`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = ${schema}
    `.execute(db),
    sql<{ table_name: string; constraint_name: string }>`
      SELECT table_name, constraint_name
      FROM information_schema.table_constraints
      WHERE table_schema = ${schema}
    `.execute(db),
    sql<{ indexname: string }>`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = ${schema}
    `.execute(db)
  ])

  const columns = new Map<string, Set<string>>()
  for (const row of columnsResult.rows) {
    addToMap(columns, row.table_name, row.column_name)
  }

  const constraints = new Map<string, Set<string>>()
  for (const row of constraintsResult.rows) {
    addToMap(constraints, row.table_name, row.constraint_name)
  }

  return {
    tables: new Set(tablesResult.rows.map(row => row.table_name)),
    columns,
    constraints,
    indexes: new Set(indexesResult.rows.map(row => row.indexname))
  }
}

function renderPlanSql(namespace: string, statements: readonly string[]): string {
  if (statements.length === 0) return ''
  const searchPath = quoteIdentifier(namespace)
  return [
    `SET search_path TO ${searchPath}, pg_catalog;`,
    '',
    statements.map(statement => `${statement};`).join('\n\n'),
    '',
    'RESET search_path;',
    ''
  ].join('\n')
}

async function createPlan<DB>(
  db: Kysely<DB>,
  configuredSchema?: string
): Promise<MigrationPlan> {
  const namespace = await resolveSchema(db, configuredSchema)
  const state = await inspectPostgresSchema(db, namespace)
  const statements: string[] = []
  const toBeCreated: string[] = []
  const toBeAdded: string[] = []
  const existingTables = new Set<string>()

  for (const table of POSTGRES_NEWSLETTER_SCHEMA.tables) {
    if (!state.tables.has(table.name)) {
      toBeCreated.push(table.name)
      statements.push(renderPostgresCreateTable(table))
    } else {
      existingTables.add(table.name)
    }
  }

  for (const table of POSTGRES_NEWSLETTER_SCHEMA.tables) {
    if (!existingTables.has(table.name)) continue
    const columns = state.columns.get(table.name) ?? new Set<string>()
    for (const column of table.columns) {
      if (columns.has(column.name)) continue
      toBeAdded.push(`${table.name}.${column.name}`)
      statements.push(renderPostgresAddColumn(table, column))
    }
  }

  for (const table of POSTGRES_NEWSLETTER_SCHEMA.tables) {
    if (!existingTables.has(table.name)) continue
    const constraints = state.constraints.get(table.name) ?? new Set<string>()
    for (const constraint of table.constraints) {
      if (constraints.has(constraint.name)) continue
      toBeAdded.push(`constraint:${constraint.name}`)
      statements.push(renderPostgresAddConstraint(table, constraint))
    }
  }

  for (const index of POSTGRES_NEWSLETTER_SCHEMA.indexes) {
    if (state.indexes.has(index.name)) continue
    toBeAdded.push(`index:${index.name}`)
    statements.push(renderPostgresCreateIndex(index))
  }

  return {
    dialect: 'postgres',
    runtimeVersion: BETTER_NEWSLETTER_VERSION,
    targetRevision: POSTGRES_NEWSLETTER_SCHEMA.revision,
    kind: existingTables.size === 0
      && !POSTGRES_NEWSLETTER_SCHEMA.indexes.some(index => state.indexes.has(index.name))
      ? 'initial' : 'delta',
    namespace,
    toBeCreated,
    toBeAdded,
    statements,
    sql: renderPlanSql(namespace, statements),
    isCurrent: statements.length === 0
  }
}

export function postgresMigration<DB>(
  db: Kysely<DB>,
  options: PostgresMigrationOptions = {}
): MigrationProvider {
  return {
    dialect: 'postgres',
    plan: () => createPlan(db, options.schema),
    async apply(plan) {
      if (plan.dialect !== 'postgres') {
        throw new Error(`Cannot apply a ${plan.dialect} migration with the PostgreSQL provider.`)
      }
      if (plan.isCurrent) return

      await db.transaction().setIsolationLevel('read committed').execute(async trx => {
        await sql`
          SELECT pg_advisory_xact_lock(hashtext('better-newsletter'), hashtext(${plan.namespace}))
        `.execute(trx)
        const current = await createPlan(trx, plan.namespace)
        if (current.isCurrent) return
        if (current.statements.length !== plan.statements.length
          || current.statements.some((statement, index) => statement !== plan.statements[index])) {
          throw new Error('PostgreSQL schema changed since the migration was planned. Re-plan and review before applying.')
        }
        await sql.raw(
          `SET LOCAL search_path TO ${quoteIdentifier(plan.namespace)}, pg_catalog`
        ).execute(trx)
        for (const statement of plan.statements) {
          await sql.raw(statement).execute(trx)
        }
      })
    }
  }
}
