import { execFileSync } from 'node:child_process'
import console from 'node:console'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

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

  run('pnpm', ['install', '--ignore-scripts', '--config.auto-install-peers=false'], consumer)
  for (const peer of Object.keys(runtimeManifest.peerDependencies ?? {})) {
    if (!Object.hasOwn(peers, peer) && existsSync(join(consumer, 'node_modules', peer))) {
      throw new Error(`Unexpected optional peer in ${name} consumer: ${peer}`)
    }
  }
  if (name === 'postgres' && existsSync(join(consumer, 'node_modules', 'pg'))) {
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
    '.', './adapters/memory', './adapters/postgres', './mailers/resend',
    './security', './storage', './db/migration', './nuxt', './nuxt/server',
    './nuxt/client', './package.json'
  ], ['package/migrations/postgres/001_newsletter.sql'])
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
import * as security from 'better-newsletter/security'
import * as storage from 'better-newsletter/storage'
import { getMigrations, type BetterNewsletterMigrationConfig, type NewsletterMigrations } from 'better-newsletter/db/migration'
declare const options: BetterNewsletterOptions
declare const migrationConfig: BetterNewsletterMigrationConfig
const create: (options: BetterNewsletterOptions) => BetterNewsletter = betterNewsletter
const service: BetterNewsletter = create(options)
const memory = memoryAdapter()
const migrations: Promise<NewsletterMigrations> = getMigrations(migrationConfig)
void [service, memory, migrations, security, storage]
`, `
import { betterNewsletter } from 'better-newsletter'
import { memoryAdapter } from 'better-newsletter/adapters/memory'
import { getMigrations } from 'better-newsletter/db/migration'
const modules = await Promise.all([
  import('better-newsletter/security'), import('better-newsletter/storage'),
])
if (typeof betterNewsletter !== 'function' || typeof memoryAdapter !== 'function' ||
    typeof getMigrations !== 'function' || !Object.keys(modules[0]).length) {
  throw new Error('Core runtime imports are incomplete')
}
`)

  checkConsumer('postgres', runtimeDependency, {
    kysely: runtimeManifest.peerDependencies.kysely
  }, `
import { postgresAdapter } from 'better-newsletter/adapters/postgres'
import type { Kysely } from 'kysely'
declare const db: Kysely<{}>
const storage = postgresAdapter(db)
void storage
`, `
import { postgresAdapter } from 'better-newsletter/adapters/postgres'
if (typeof postgresAdapter !== 'function') throw new Error('PostgreSQL adapter is missing')
`)

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
import { createNewsletterClient } from 'better-newsletter/nuxt/client'
type Routes = Parameters<typeof createNewsletterClient>[0]
declare const routes: Routes
const client = createNewsletterClient(routes)
void [module, server, client.subscribe]
`, `
import { createNewsletterClient } from 'better-newsletter/nuxt/client'
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
  }, {}, `
import type { NewsletterMigrations } from 'better-newsletter/db/migration'
declare const migrations: NewsletterMigrations
void migrations
`, `
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const cli = require('@better-newsletter/cli/package.json')
const runtime = require('better-newsletter/package.json')
if (cli.dependencies['better-newsletter'] !== runtime.version) {
  throw new Error('CLI runtime dependency is not pinned to the packed version')
}
`)
  run('pnpm', ['exec', 'better-newsletter', '--help'], cliConsumer)
  console.log('\nBoth packed-artifact smoke tests passed')
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
