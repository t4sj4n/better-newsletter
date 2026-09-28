import { execFileSync } from 'node:child_process'
import console from 'node:console'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const scratch = mkdtempSync(join(tmpdir(), 'better-newsletter-pack-smoke-'))

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

function checkArchive(tarball) {
  const files = new Set(output('tar', ['-tzf', tarball]).trim().split('\n'))
  const packed = JSON.parse(output('tar', ['-xOzf', tarball, 'package/package.json']))
  if (packed.name !== manifest.name) {
    throw new Error(`Unexpected packed package: ${packed.name}`)
  }

  for (const subpath of [
    '.', './memory', './security', './postgres', './resend',
    './nuxt', './nuxt/server', './nuxt/client'
  ]) {
    if (!packed.exports?.[subpath]) {
      throw new Error(`Missing package export: ${subpath}`)
    }
  }
  if (packed.exports?.['./kysely']) {
    throw new Error('The unpublished ./kysely export must not be shipped')
  }

  const required = new Set([
    'package/package.json',
    'package/README.md',
    'package/LICENSE',
    'package/migrations/postgres/001_newsletter.sql'
  ])
  for (const [subpath, entry] of Object.entries(packed.exports)) {
    for (const target of typeof entry === 'string' ? [entry] : Object.values(entry)) {
      if (typeof target !== 'string' || !target.startsWith('./')) {
        throw new Error(`Invalid export target for ${subpath}: ${target}`)
      }
      required.add(`package/${target.slice(2)}`)
    }
  }
  for (const file of required) {
    if (!files.has(file)) {
      throw new Error(`Missing packed file: ${file}`)
    }
  }
  for (const file of files) {
    if (/^package\/(?:playground|examples|test|scripts)(?:\/|$)/u.test(file)) {
      throw new Error(`Development-only file shipped in packed package: ${file}`)
    }
  }
  console.log(`Checked ${packed.name} exports and migration in the tarball`)
}

function checkConsumer(name, tarball, peers, types, runtime) {
  const consumer = join(scratch, name)
  mkdirSync(consumer)
  writeJson(join(consumer, 'package.json'), {
    name: `packed-${name}-consumer`,
    private: true,
    type: 'module',
    packageManager: manifest.packageManager,
    dependencies: {
      [manifest.name]: `file:${tarball}`,
      typescript: manifest.devDependencies.typescript,
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
  for (const peer of Object.keys(manifest.peerDependencies ?? {})) {
    if (!Object.hasOwn(peers, peer) && existsSync(join(consumer, 'node_modules', peer))) {
      throw new Error(`Unexpected optional peer in ${name} consumer: ${peer}`)
    }
  }
  if (name === 'postgres' && existsSync(join(consumer, 'node_modules', 'pg'))) {
    throw new Error('PostgreSQL consumer unexpectedly installed the pg driver')
  }
  run('pnpm', ['exec', 'tsc', '-p', 'tsconfig.json'], consumer)
  run('node', ['--no-warnings=ExperimentalWarning', '--loader', join(scratch, 'isolate.mjs'), 'smoke.mjs'],
    consumer, { ...process.env, SMOKE_CONSUMER_ROOT: consumer })
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    rmSync(scratch, { recursive: true, force: true })
    process.exit(128 + (signal === 'SIGINT' ? 2 : 15))
  })
}

try {
  writeFileSync(join(scratch, 'isolate.mjs'), `
import { sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context)
  if (resolved.url.startsWith('file:') &&
      !fileURLToPath(resolved.url).startsWith(process.env.SMOKE_CONSUMER_ROOT + sep)) {
    throw new Error('Import escaped clean consumer: ' + specifier + ' -> ' + resolved.url)
  }
  return resolved
}
`)

  run('pnpm', ['pack', '--pack-destination', scratch])
  const tarballs = readdirSync(scratch).filter((file) => file.endsWith('.tgz'))
  if (tarballs.length !== 1) {
    throw new Error(`Expected one packed tarball, found ${tarballs.length}`)
  }
  const tarball = join(scratch, tarballs[0])
  checkArchive(tarball)
  run('pnpm', ['exec', 'publint', tarball, '--strict'])

  checkConsumer('core', tarball, {}, `
import * as core from 'better-newsletter'
import * as memory from 'better-newsletter/memory'
import * as security from 'better-newsletter/security'
const imports: [typeof core, typeof memory, typeof security] = [core, memory, security]
void imports
`, `
const [core, memory, security] = await Promise.all([
  import('better-newsletter'),
  import('better-newsletter/memory'),
  import('better-newsletter/security')
])
if (typeof core.createNewsletter !== 'function' ||
    !Object.keys(memory).length || !Object.keys(security).length) {
  throw new Error('Core runtime imports are incomplete')
}
`)

  checkConsumer('postgres', tarball, {
    kysely: manifest.peerDependencies.kysely
  }, `
import { postgresStorage, postgresRateLimiter } from 'better-newsletter/postgres'
import type { Kysely } from 'kysely'
declare const hostDb: Kysely<{}>
const storage = postgresStorage(hostDb)
const limiter = postgresRateLimiter(hostDb)
void [storage, limiter]
`, `
import { postgresStorage, postgresRateLimiter } from 'better-newsletter/postgres'
if (typeof postgresStorage !== 'function' || typeof postgresRateLimiter !== 'function') {
  throw new Error('PostgreSQL adapter runtime exports are missing')
}
if (typeof postgresStorage({})?.transaction !== 'function' ||
    typeof postgresRateLimiter({})?.consume !== 'function') {
  throw new Error('PostgreSQL adapters cannot be constructed from a host Kysely database')
}
`)

  checkConsumer('resend', tarball, {}, `
import { resendMailer } from 'better-newsletter/resend'
const mailer = resendMailer({
  apiKey: 'smoke-only',
  from: 'test@example.com',
  renderConfirmation: () => ({ subject: 'Test', text: 'Test' })
})
void mailer
`, `
import { resendMailer } from 'better-newsletter/resend'
const mailer = resendMailer({
  apiKey: 'smoke-only',
  from: 'test@example.com',
  renderConfirmation: () => ({ subject: 'Test', text: 'Test' }),
  fetch: async () => { throw new Error('The smoke test must not contact Resend') }
})
if (typeof mailer.sendConfirmation !== 'function') {
  throw new Error('Resend API-key adapter could not be constructed without the SDK')
}
`)

  checkConsumer('nuxt', tarball, {
    '@nuxt/kit': manifest.peerDependencies['@nuxt/kit'],
    h3: manifest.peerDependencies.h3,
    nuxt: manifest.peerDependencies.nuxt
  }, `
import * as core from 'better-newsletter'
import * as module from 'better-newsletter/nuxt'
import * as server from 'better-newsletter/nuxt/server'
import * as client from 'better-newsletter/nuxt/client'
const imports: [typeof core, typeof module, typeof server, typeof client] =
  [core, module, server, client]
void imports
`, `
const [module, server, client] = await Promise.all([
  import('better-newsletter/nuxt'),
  import('better-newsletter/nuxt/server'),
  import('better-newsletter/nuxt/client')
])
if (typeof module.default !== 'function' || !Object.keys(server).length) {
  throw new Error('Nuxt runtime imports are incomplete')
}
void client
`)
  console.log('\nPacked-artifact smoke test passed')
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
