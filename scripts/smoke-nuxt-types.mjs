import { spawnSync } from 'node:child_process'
import console from 'node:console'
import { cpSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath, URL } from 'node:url'

const fixture = fileURLToPath(new URL('../test/fixtures/nuxt-type-limit/', import.meta.url))

export function checkNuxtRouteTypes({ scratch, runtimeTarball, run }) {
  const consumer = join(scratch, 'nuxt-route-types')
  cpSync(fixture, consumer, { recursive: true })
  const manifest = JSON.parse(readFileSync(join(consumer, 'package.json'), 'utf8'))
  const upstreamOverrides = manifest.pnpm.overrides
  const versionMatrix = Object.entries({
    ...manifest.dependencies, ...manifest.devDependencies, ...upstreamOverrides
  }).filter(([name]) => name !== 'better-newsletter')
    .map(([name, version]) => `${name} ${version}`).join(', ')
  manifest.dependencies['better-newsletter'] = `file:${runtimeTarball}`
  delete manifest.pnpm
  writeFileSync(join(consumer, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  // The parent smoke workspace owns overrides; pin the upstream matcher used by this reproduction.
  const workspace = JSON.parse(readFileSync(join(scratch, 'package.json'), 'utf8'))
  Object.assign(workspace.pnpm.overrides, upstreamOverrides)
  writeFileSync(join(scratch, 'package.json'), `${JSON.stringify(workspace, null, 2)}\n`)

  run('pnpm', ['install', '--no-frozen-lockfile', '--ignore-scripts', '--config.auto-install-peers=false'], consumer)

  // The package regression runs first; the upstream probe has a separate maintenance contract.
  verifyBetterNewsletterRouteTyping(consumer, run)
  reproducePinnedUpstreamLimit(consumer, run, versionMatrix)
}

function reproducePinnedUpstreamLimit(consumer, run, versionMatrix) {
  run('node', ['setup.mjs', 'broad'], consumer)
  for (const enabled of [false, true]) {
    const result = spawnSync('pnpm', ['exec', 'nuxt', 'typecheck'], {
      cwd: consumer,
      env: { ...process.env, SMOKE_WITH_NEWSLETTER: String(enabled) },
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024
    })
    if (result.error) throw result.error
    const diagnostics = `${result.stdout}\n${result.stderr}`
    const errors = diagnostics.split('\n').filter(line => /error TS\d+/u.test(line))
    if (result.status === 0 && errors.length === 0 && result.signal == null) {
      throw new Error(
        `The pinned upstream reproduction no longer produces TS2589 (newsletter=${enabled}).\n`
        + `Version matrix: ${versionMatrix}\n`
        + 'Re-evaluate the Nuxt/Nitro/TypeScript version matrix and update or retire the negative reproduction. '
        + 'This may indicate an upstream fix, not a Better Newsletter regression. '
        + 'Do not artificially restore TS2589; keep the positive route-typing regression.\n'
        + diagnostics
      )
    }
    if (result.status === 0 || result.signal != null || errors.length === 0
        || errors.some(line => !/app\/app.vue\(\d+,\d+\): error TS2589:/u.test(line))) {
      throw new Error(`Pinned upstream probe failed unexpectedly (newsletter=${enabled}, status=${result.status}, signal=${result.signal}). Expected only TS2589 in app/app.vue.\nVersion matrix: ${versionMatrix}\n${diagnostics}`)
    }
    console.log(`Reproduced version-pinned upstream TS2589 with newsletter routes ${enabled ? 'enabled' : 'disabled'}`)
  }
}

function verifyBetterNewsletterRouteTyping(consumer, run) {
  run('node', ['setup.mjs', 'narrow'], consumer)
  run('pnpm', ['exec', 'nuxt', 'typecheck'], consumer, {
    ...process.env, SMOKE_WITH_NEWSLETTER: 'true'
  })
  const generated = readFileSync(join(consumer, '.nuxt/types/nitro-routes.d.ts'), 'utf8')
  for (const action of ['subscribe', 'resend-confirmation', 'confirm', 'unsubscribe', 'unsubscribe-all', 'preferences']) {
    if (!generated.includes(`'/api/newsletter/${action}':`)) {
      throw new Error(`Missing generated newsletter route type: ${action}`)
    }
  }
  console.log('Packed Nuxt typecheck passed with literal request types and all six module routes retained')
}
