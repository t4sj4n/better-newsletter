import { execFileSync } from 'node:child_process'
import console from 'node:console'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { checkNuxtHandler } from './smoke-nuxt-handler.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const runtimeManifest = JSON.parse(readFileSync(join(root, 'packages/better-newsletter/package.json'), 'utf8'))
const cliManifest = JSON.parse(readFileSync(join(root, 'packages/cli/package.json'), 'utf8'))
const rootManifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const scratch = join(root, `.smoke-pack-${randomUUID()}`)
mkdirSync(scratch)

function run(command, args, cwd = root, env = process.env) {
  console.log(`\n$ ${command} ${args.join(' ')}`)
  execFileSync(command, args, { cwd, env, stdio: 'inherit' })
}

function output(command, args) {
  return execFileSync(command, args, { cwd: root, encoding: 'utf8' })
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

function packedTarball(manifest) {
  return join(scratch, `${manifest.name.replace(/^@/u, '').replaceAll('/', '-')}-${manifest.version}.tgz`)
}

function checkArchive(tarball, manifest, expectedExports, requiredFiles) {
  const files = new Set(output('tar', ['-tzf', tarball]).trim().split('\n'))
  const packed = JSON.parse(output('tar', ['-xOzf', tarball, 'package/package.json']))
  if (packed.name !== manifest.name || packed.version !== manifest.version) {
    throw new Error(`Unexpected packed package: ${packed.name}@${packed.version}`)
  }
  if (packed.homepage !== manifest.homepage || packed.publishConfig?.access !== 'public'
      || !Array.isArray(packed.keywords) || packed.keywords.length === 0) {
    throw new Error(`Missing publish metadata for ${packed.name}`)
  }
  if (JSON.stringify(Object.keys(packed.exports ?? {}).sort()) !== JSON.stringify(expectedExports.sort())) {
    throw new Error(`Unexpected exports for ${packed.name}: ${Object.keys(packed.exports ?? {})}`)
  }

  const required = new Set(['package/package.json', 'package/README.md', 'package/LICENSE', ...requiredFiles])
  for (const [subpath, entry] of Object.entries(packed.exports ?? {})) {
    if (subpath === './package.json') continue
    if (typeof entry !== 'object' || !entry.types || !entry.import) {
      throw new Error(`Missing types or import target for ${packed.name}/${subpath}`)
    }
    for (const target of Object.values(entry)) {
      if (typeof target !== 'string' || !target.startsWith('./')) {
        throw new Error(`Invalid export target for ${packed.name}/${subpath}: ${target}`)
      }
      required.add(`package/${target.slice(2)}`)
    }
  }
  for (const file of required) {
    if (!files.has(file)) throw new Error(`Missing packed file: ${file}`)
  }
  for (const file of files) {
    if (/^package\/(?:playground|examples|test|scripts|src)(?:\/|$)/u.test(file)) {
      throw new Error(`Development-only file shipped by ${packed.name}: ${file}`)
    }
  }
  return { packed, files }
}

function checkConsumer(name, dependencies, peers, types, runtime) {
  const consumer = join(scratch, name)
  mkdirSync(consumer)
  writeJson(join(consumer, 'package.json'), {
    name: `packed-${name}-consumer`,
    private: true,
    type: 'module',
    packageManager: rootManifest.packageManager,
    dependencies: {
      ...dependencies,
      typescript: rootManifest.devDependencies.typescript,
      ...peers
    }
  })
  writeJson(join(consumer, 'tsconfig.json'), {
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      types: []
    },
    files: ['smoke.mts']
  })
  writeFileSync(join(consumer, 'smoke.mts'), types)
  writeFileSync(join(consumer, 'smoke.mjs'), runtime)

  run('pnpm', ['install', '--no-frozen-lockfile', '--ignore-scripts', '--config.auto-install-peers=false',
    ...(name.startsWith('postgres-') || name === 'cli' ? ['--strict-peer-dependencies'] : [])], consumer)
  for (const peer of Object.keys(runtimeManifest.peerDependencies ?? {})) {
    if (!Object.hasOwn(peers, peer) && existsSync(join(consumer, 'node_modules', peer))) {
      throw new Error(`Unexpected optional peer in ${name} consumer: ${peer}`)
    }
  }
  if (name.startsWith('postgres-') && existsSync(join(consumer, 'node_modules', 'pg'))) {
    throw new Error('PostgreSQL consumer unexpectedly installed the pg driver')
  }
  if (name === 'core' && (
    existsSync(join(consumer, 'node_modules', 'jiti'))
    || existsSync(join(consumer, 'node_modules', '@better-newsletter', 'cli'))
    || existsSync(join(consumer, 'node_modules', '.bin', 'better-newsletter'))
  )) {
    throw new Error('Runtime-only consumer unexpectedly installed the CLI or jiti')
  }
  run('pnpm', ['exec', 'tsc', '-p', 'tsconfig.json'], consumer)
  run('node', ['--no-warnings=ExperimentalWarning', '--loader', join(scratch, 'isolate.mjs'), 'smoke.mjs'],
    consumer, { ...process.env, SMOKE_CONSUMER_ROOT: consumer, SMOKE_INSTALL_ROOT: join(scratch, 'node_modules') })
  return consumer
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    rmSync(scratch, { recursive: true, force: true })
    process.exit(128 + (signal === 'SIGINT' ? 2 : 15))
  })
}

try {
  writeFileSync(join(scratch, 'pnpm-workspace.yaml'), "packages:\n  - '*'\nautoInstallPeers: false\n")
  writeFileSync(join(scratch, 'isolate.mjs'), `
import { sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context)
  if (resolved.url.startsWith('file:') &&
      !fileURLToPath(resolved.url).startsWith(process.env.SMOKE_CONSUMER_ROOT + sep) &&
      !fileURLToPath(resolved.url).startsWith(process.env.SMOKE_INSTALL_ROOT + sep)) {
    throw new Error('Import escaped clean consumer: ' + specifier + ' -> ' + resolved.url)
  }
  return resolved
}
`)

  run('pnpm', ['pack', '--pack-destination', scratch], join(root, 'packages/better-newsletter'))
  run('pnpm', ['pack', '--pack-destination', scratch], join(root, 'packages/cli'))
  const tarballs = readdirSync(scratch).filter(file => file.endsWith('.tgz'))
  if (tarballs.length !== 2) throw new Error(`Expected two packed tarballs, found ${tarballs.length}`)
  const runtimeTarball = packedTarball(runtimeManifest)
  const cliTarball = packedTarball(cliManifest)
  const runtime = checkArchive(runtimeTarball, runtimeManifest, [
    '.', './client', './adapters/memory', './adapters/postgres', './mailers', './mailers/resend',
    './webhooks/resend',
    './security', './storage', './db/migration', './nuxt', './nuxt/server',
    './nuxt/client', './nuxt/handler', './package.json'
  ], ['package/migrations/postgres/001_newsletter.sql'])
  if ([...runtime.files].some(file => file.startsWith('package/dist/nuxt/routes/'))) {
    throw new Error('Packed runtime still contains obsolete individual newsletter routes')
  }
  if (runtime.packed.peerDependencies?.kysely !== '>=0.28.17 <0.30.0') {
    throw new Error('Packed runtime must declare the supported Kysely peer range')
  }
  if (runtime.packed.bin || runtime.packed.dependencies?.jiti
      || [...runtime.files].some(file => /^package\/dist\/cli(?:\/|\.|$)/u.test(file))) {
    throw new Error('Runtime package must not include the CLI or jiti')
  }
  const cli = checkArchive(cliTarball, cliManifest, [], ['package/dist/cli.js'])
  if (cli.packed.bin?.['better-newsletter'] !== './dist/cli.js'
      || cli.packed.dependencies?.['better-newsletter'] !== runtimeManifest.version
      || !cli.packed.dependencies?.jiti) {
    throw new Error('CLI tarball must include the binary, jiti, and exact runtime version')
  }
  run('pnpm', ['exec', 'publint', runtimeTarball, '--strict'])
  run('pnpm', ['exec', 'publint', cliTarball, '--strict'])
  run('pnpm', ['exec', 'attw', runtimeTarball, '--format', 'table', '--profile', 'esm-only'])
  run('pnpm', [
    'exec', 'attw', cliTarball, '--format', 'table', '--profile', 'esm-only',
    '--entrypoints', './dist/cli.js'
  ])

  writeJson(join(scratch, 'package.json'), {
    name: 'packed-artifact-smoke',
    private: true,
    pnpm: {
      overrides: { 'better-newsletter': `file:${runtimeTarball}` }
    }
  })
  const runtimeDependency = { 'better-newsletter': `file:${runtimeTarball}` }
  checkConsumer('core', runtimeDependency, {}, `
import { betterNewsletter, type BetterNewsletterOptions, type BetterNewsletter } from 'better-newsletter'
import { memoryAdapter } from 'better-newsletter/adapters/memory'
import { createNewsletterClient, type NewsletterClient } from 'better-newsletter/client'
import { createNewsletterClient as createLegacyNewsletterClient } from 'better-newsletter/nuxt/client'
const browserClient: NewsletterClient = createNewsletterClient()
const legacyClient = createLegacyNewsletterClient()
void browserClient.confirm
void legacyClient.confirm
import { MAIL_DELIVERY_REASONS, type NewsletterMailer, type ConfirmationMailInput } from 'better-newsletter/mailers'
import type { NewsletterCapabilities, AbuseGuard, RateLimiter, RateLimitKeyProvider, NewsletterRateLimitCheck } from 'better-newsletter/security'
import type { NewsletterStorage } from 'better-newsletter/storage'
import * as security from 'better-newsletter/security'
import { createSecureCapabilities, createHmacSuppressionKeyProvider } from 'better-newsletter/security'
import * as storage from 'better-newsletter/storage'
import { getMigrations, type BetterNewsletterMigrationConfig, type NewsletterMigrations } from 'better-newsletter/db/migration'
// @ts-expect-error storage implementation contracts are exported from /storage
import type { NewsletterStorage as RootNewsletterStorage } from 'better-newsletter'
// @ts-expect-error capability implementation contracts are exported from /security
import type { NewsletterCapabilities as RootNewsletterCapabilities } from 'better-newsletter'
// @ts-expect-error abuse contracts are exported from /security
import type { AbuseGuard as RootAbuseGuard } from 'better-newsletter'
// @ts-expect-error rate limiting contracts are exported from /security
import type { RateLimiter as RootRateLimiter } from 'better-newsletter'
// @ts-expect-error key provider contracts are exported from /security
import type { RateLimitKeyProvider as RootRateLimitKeyProvider } from 'better-newsletter'
// @ts-expect-error rate-limit policy contracts are exported from /security
import type { RateLimitPolicy as RootRateLimitPolicy } from 'better-newsletter'
// @ts-expect-error advanced rate-limit checks are exported from /security
import type { NewsletterRateLimitCheck as RootNewsletterRateLimitCheck } from 'better-newsletter'
// @ts-expect-error mailer implementation contracts are exported from /mailers
import type { NewsletterMailer as RootMailer } from 'better-newsletter'
// @ts-expect-error mailer delivery inputs are exported from /mailers
import type { ConfirmationMailInput as RootConfirmationMailInput } from 'better-newsletter'
// @ts-expect-error suppression security helper is exported from /security
import { createHmacSuppressionKeyProvider as RootSuppressionProvider } from 'better-newsletter'
// @ts-expect-error signing configuration requires at least one secret format
createSecureCapabilities({})
createSecureCapabilities({ hmacSecret: '0123456789abcdef0123456789abcdef' })
createSecureCapabilities({ secrets: [{ version: 1, value: '0123456789abcdef0123456789abcdef' }] })
createSecureCapabilities({
  hmacSecret: '0123456789abcdef0123456789abcdef',
  secrets: [{ version: 1, value: 'fedcba9876543210fedcba9876543210' }],
  issueLegacyCapabilities: true
})
createHmacSuppressionKeyProvider({ secrets: [{ version: 1, value: '0123456789abcdef0123456789abcdef' }] })
declare const options: BetterNewsletterOptions
declare const migrationConfig: BetterNewsletterMigrationConfig
declare const mailer: NewsletterMailer
const create: (options: BetterNewsletterOptions) => BetterNewsletter = betterNewsletter
const service: BetterNewsletter = create(options)
const memory = memoryAdapter()
const migrations: Promise<NewsletterMigrations> = getMigrations(migrationConfig)
void [service, memory, migrations, security, storage, mailer, MAIL_DELIVERY_REASONS]
`, `
import { betterNewsletter } from 'better-newsletter'
import { memoryAdapter } from 'better-newsletter/adapters/memory'
import { getMigrations } from 'better-newsletter/db/migration'
const { createNewsletterClient } = await import('better-newsletter/client')
const { createNewsletterClient: createLegacyNewsletterClient } = await import('better-newsletter/nuxt/client')
if (typeof createNewsletterClient().confirm !== 'function' || typeof createLegacyNewsletterClient().confirm !== 'function') {
  throw new Error('Client requires unexpected framework peers')
}
const modules = await Promise.all([
  import('better-newsletter/security'), import('better-newsletter/storage'),
  import('better-newsletter/mailers')
])
if (typeof betterNewsletter !== 'function' || typeof memoryAdapter !== 'function' ||
    typeof getMigrations !== 'function' || !Object.keys(modules[0]).length ||
    !Object.keys(modules[2]).length) {
  throw new Error('Core runtime imports are incomplete')
}
`)

  // Exercise the oldest supported version, the reported host version, and
  // the current 0.29 release without duplicating Nuxt or other consumers.
  for (const version of ['0.28.17', '0.29.5', '0.29.6']) {
    checkConsumer(`postgres-${version}`, runtimeDependency, { kysely: version }, `
import { postgresAdapter, postgresRateLimiter, postgresMigration } from 'better-newsletter/adapters/postgres'
import type { Kysely } from 'kysely'
declare const db: Kysely<{ hostTable: { id: string } }>
const storage = postgresAdapter(db)
const limiter = postgresRateLimiter(db)
const migration = postgresMigration(db)
void [storage, limiter.consume, migration.plan, migration.apply]
`, `
import { postgresAdapter, postgresRateLimiter, postgresMigration } from 'better-newsletter/adapters/postgres'
import { sql } from 'kysely'
if ([postgresAdapter, postgresRateLimiter, postgresMigration].some(value => typeof value !== 'function')
    || typeof sql !== 'function') throw new Error('PostgreSQL runtime imports are missing')
`)
  }

  checkConsumer('resend', runtimeDependency, {}, `
import { resendMailer } from 'better-newsletter/mailers/resend'
const mailer = resendMailer({
  apiKey: 'smoke-only',
  from: 'test@example.com',
  renderConfirmation: () => ({ subject: 'Test', text: 'Test' })
})
void mailer.sendConfirmation
`, `
import { resendMailer } from 'better-newsletter/mailers/resend'
if (typeof resendMailer !== 'function') throw new Error('Resend mailer is missing')
`)

  checkConsumer('nuxt', runtimeDependency, {
    '@nuxt/kit': runtimeManifest.peerDependencies['@nuxt/kit'],
    h3: runtimeManifest.peerDependencies.h3,
    nuxt: runtimeManifest.peerDependencies.nuxt
  }, `
import * as module from 'better-newsletter/nuxt'
import * as server from 'better-newsletter/nuxt/server'
import type { BetterNewsletterServerConfig } from 'better-newsletter/nuxt/server'
import type { JsonValue } from 'better-newsletter'
const syncMapper: BetterNewsletterServerConfig['publicSubscribeMetadata'] = (_event, body) => ({
  placement: body.placement === 'pricing' ? 'pricing' : 'other'
})
const asyncMapper: BetterNewsletterServerConfig['publicSubscribeMetadata'] = async () => ({ trusted: true })
const omittedMapper: BetterNewsletterServerConfig['publicSubscribeMetadata'] = () => undefined
const asyncOmittedMapper: BetterNewsletterServerConfig['publicSubscribeMetadata'] = async () => undefined
const checkedMapper: BetterNewsletterServerConfig['publicSubscribeMetadata'] = () => {
  const metadata: Readonly<Record<string, JsonValue>> = { context: { nested: ['value', null] } }
  return metadata
}
// @ts-expect-error metadata must contain JSON values
const invalidMapper: BetterNewsletterServerConfig['publicSubscribeMetadata'] = () => ({ invalid: new Date() })
void [syncMapper, asyncMapper, omittedMapper, asyncOmittedMapper, checkedMapper, invalidMapper]
import { createNewsletterClient } from 'better-newsletter/client'
type Routes = Parameters<typeof createNewsletterClient>[0]
declare const routes: Routes
const client = createNewsletterClient(routes)
void [module, server, client.subscribe]
`, `
import { createNewsletterClient } from 'better-newsletter/client'
const [module, server] = await Promise.all([
  import('better-newsletter/nuxt'), import('better-newsletter/nuxt/server')
])
if (typeof module.default !== 'function' || !Object.keys(server).length ||
    typeof createNewsletterClient !== 'function') {
  throw new Error('Nuxt runtime imports are incomplete')
}
`)

  const cliConsumer = checkConsumer('cli', {
    ...runtimeDependency,
    '@better-newsletter/cli': `file:${cliTarball}`
  }, {
    kysely: '0.29.5',
    pg: rootManifest.devDependencies.pg,
    '@nuxt/kit': '4.5.2',
    h3: runtimeManifest.peerDependencies.h3,
    nuxt: '4.5.2'
  }, `
import type { NewsletterMigrations } from 'better-newsletter/db/migration'
import type { CreateConfirmationTokenInput } from 'better-newsletter'
import type { ConfirmationReplacementStrategy } from 'better-newsletter/security'
import type { NewsletterStorageTransaction } from 'better-newsletter/storage'
import { defineBetterNewsletterConfig, useBetterNewsletter, type BetterNewsletterServerConfig, type NewsletterServerConfiguration } from 'better-newsletter/nuxt/server'
import { postgresAdapter, postgresMigration } from 'better-newsletter/adapters/postgres'
import type { Kysely } from 'kysely'
import type { H3Event } from 'h3'
declare const migrations: NewsletterMigrations
declare const db: Kysely<{ hostTable: { id: string } }>
declare const event: H3Event
declare const config: BetterNewsletterServerConfig
declare const transaction: NewsletterStorageTransaction
const replacementStrategy: ConfirmationReplacementStrategy = 'REPLACE_PREVIOUS'
const input: CreateConfirmationTokenInput = { subscription: { id: 'subscription' }, replacementStrategy, eventMetadata: { actorId: 'admin' } }
const requestConfiguration: NewsletterServerConfiguration = defineBetterNewsletterConfig(currentEvent => {
  const sameType: H3Event = currentEvent
  void sameType
  return config
})
void defineBetterNewsletterConfig(() => config)
const service = await useBetterNewsletter(event, requestConfiguration)
await service.createConfirmationToken(input)
await service.getConfirmationState({ subscription: input.subscription })
await transaction.getLatestUsableConfirmationExpiry({ subscriptionId: 'subscription', lifecycleGeneration: 1, now: new Date() })
const runtimeVersion: string = migrations.runtimeVersion
const targetRevision: number = migrations.targetRevision
const kind: 'initial' | 'delta' = migrations.kind
void [runtimeVersion, targetRevision, kind, migrations, postgresAdapter(db), postgresMigration(db)]
`, `
import { createRequire } from 'node:module'
import { memoryAdapter } from 'better-newsletter/adapters/memory'
import { createSecureCapabilities } from 'better-newsletter/security'
import { useBetterNewsletter } from 'better-newsletter/nuxt/server'
import { postgresAdapter, postgresMigration } from 'better-newsletter/adapters/postgres'
import { getMigrations } from 'better-newsletter/db/migration'
const require = createRequire(import.meta.url)
const cli = require('@better-newsletter/cli/package.json')
const runtime = require('better-newsletter/package.json')
if (cli.dependencies['better-newsletter'] !== runtime.version || runtime.peerDependencies.kysely !== '>=0.28.17 <0.30.0') {
  throw new Error('Packed CLI/runtime versions or Kysely peer range are incorrect')
}
if ([postgresAdapter, postgresMigration, getMigrations].some(value => typeof value !== 'function')) {
  throw new Error('Packed PostgreSQL/migration exports are incomplete')
}
const storage = memoryAdapter()
await storage.transaction(async transaction => {
  if (await transaction.getLatestUsableConfirmationExpiry({ subscriptionId: 'missing', lifecycleGeneration: 1, now: new Date() }) !== null) {
    throw new Error('Packed storage expiry lookup is missing or incorrect')
  }
})
const service = await useBetterNewsletter({ context: {} }, {
  origin: 'https://newsletter.example', storage,
  capabilities: createSecureCapabilities({ hmacSecret: '0123456789abcdef0123456789abcdef' }),
  mailer: { async sendConfirmation() { throw new Error('Trusted creation must not send mail') } }
})
const subscription = await service.importSubscription({
  email: 'packed@example.com', status: 'PENDING_CONFIRMATION',
  consent: { version: 'v1', consentedAt: new Date() }
})
const input = { subscription: { id: subscription.id }, eventMetadata: { actorId: 'admin' } }
const created = await service.createConfirmationToken(input)
const state = await service.getConfirmationState({ subscription: input.subscription })
if (!created || !state?.canCreate || state.activeTokenExpiresAt?.getTime() !== created.expiresAt.getTime()
    || !(await service.confirm({ token: created.token })).confirmed) {
  throw new Error('Packed trusted confirmation APIs do not work through the Nuxt service')
}
`)
  run('pnpm', ['exec', 'better-newsletter', '--help'], cliConsumer)
  if (process.env.DATABASE_URL) {
    writeFileSync(join(cliConsumer, 'better-newsletter.config.ts'), `
import { Kysely, PostgresDialect } from 'kysely'
import { Pool } from 'pg'
import { postgresMigration } from 'better-newsletter/adapters/postgres'
import { defineBetterNewsletterMigrationConfig } from 'better-newsletter/db/migration'
const db = new Kysely({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: process.env.DATABASE_URL }) }) })
export default defineBetterNewsletterMigrationConfig({
  provider: postgresMigration(db, { schema: process.env.SMOKE_SCHEMA }),
  close: () => db.destroy()
})
`)
    writeFileSync(join(cliConsumer, 'canonical.sql'), output('tar', [
      '-xOzf', runtimeTarball, 'package/migrations/postgres/001_newsletter.sql'
    ]))
    writeFileSync(join(cliConsumer, 'generate-smoke.mjs'), `
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool } from 'pg'
import { postgresMigration } from 'better-newsletter/adapters/postgres'
import { getMigrations, renderMigrationSql } from 'better-newsletter/db/migration'
const runtime = createRequire(import.meta.url)('better-newsletter/package.json')
const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const db = new Kysely({ dialect: new PostgresDialect({ pool }) })
const schema = 'packed_generate_' + randomUUID().replaceAll('-', '')
const config = { provider: postgresMigration(db, { schema }) }
function cli(args) {
  execFileSync('pnpm', ['exec', 'better-newsletter', ...args, '--yes'], {
    stdio: 'inherit', env: { ...process.env, SMOKE_SCHEMA: schema }
  })
}
function header(plan) {
  return ['-- Generated by better-newsletter@' + plan.runtimeVersion,
    '-- Dialect: postgres', '-- Target schema revision: 1', '-- Plan: ' + plan.kind, '', ''].join('\\n')
}
try {
  await pool.query('CREATE SCHEMA "' + schema + '"')
  const initial = await getMigrations(config)
  assert.equal(initial.targetRevision, 1)
  assert.equal(initial.runtimeVersion, runtime.version)
  assert.equal(initial.kind, 'initial')
  cli(['generate', '--output', 'generated.sql'])
  cli(['generate', '--output', 'generated-repeat.sql'])
  const generated = readFileSync('generated.sql', 'utf8')
  assert.ok(generated.startsWith(header(initial)))
  assert.equal(readFileSync('generated-repeat.sql', 'utf8'), generated)
  assert.equal(generated, header(initial) + initial.sql)
  assert.equal(generated, renderMigrationSql(initial))
  assert.equal([
    '-- Better Newsletter canonical schema', '-- Dialect: ' + initial.dialect,
    '-- Target schema revision: ' + initial.targetRevision, '-- Plan: initial', '',
    initial.statements.map(statement => statement + ';').join('\n\n') + '\n'
  ].join('\n'), readFileSync('canonical.sql', 'utf8'))
  assert.ok(!generated.includes(process.env.DATABASE_URL))
  const tables = await pool.query('SELECT tablename FROM pg_tables WHERE schemaname = $1', [schema])
  assert.equal(tables.rowCount, 0, 'generation must not mutate the database')
  await pool.query('CREATE TABLE "' + schema + '".newsletter_contacts (id text PRIMARY KEY)')
  const partial = await getMigrations(config)
  assert.equal(partial.targetRevision, 1)
  assert.equal(partial.runtimeVersion, runtime.version)
  assert.equal(partial.kind, 'delta')
  cli(['generate', '--output', 'delta.sql'])
  assert.equal(readFileSync('delta.sql', 'utf8'), header(partial) + partial.sql)
  assert.equal(readFileSync('generated.sql', 'utf8'), generated, 'historical SQL must remain immutable')
  cli(['migrate'])
  const current = await getMigrations(config)
  assert.equal(current.targetRevision, 1)
  assert.equal(current.runtimeVersion, runtime.version)
  assert.equal(current.kind, 'delta')
  assert.equal(current.isCurrent, true)
  assert.equal(current.sql, '')
  const appliedTables = await pool.query('SELECT tablename FROM pg_tables WHERE schemaname = $1 ORDER BY tablename', [schema])
  assert.deepEqual(appliedTables.rows.map(row => row.tablename), [...initial.toBeCreated].sort())
} finally {
  try { await pool.query('DROP SCHEMA IF EXISTS "' + schema + '" CASCADE') }
  finally { await db.destroy() }
}
`)
    run('node', ['generate-smoke.mjs'], cliConsumer)
    console.log('Packed CLI revision/provenance smoke passed (initial/delta generation, immutable SQL, direct migrate without a ledger)')
  } else {
    console.log('DATABASE_URL is unset; skipping packed CLI PostgreSQL generate smoke')
  }
  checkNuxtHandler({ scratch, runtimeTarball, run })
  console.log('\nBoth packed-artifact smoke tests passed')
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
