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
  manifest.dependencies['better-newsletter'] = `file:${runtimeTarball}`
  delete manifest.pnpm
  writeFileSync(join(consumer, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  // The parent smoke workspace owns overrides; pin the upstream matcher used by this reproduction.
  const workspace = JSON.parse(readFileSync(join(scratch, 'package.json'), 'utf8'))
  workspace.pnpm.overrides.nitropack = '2.13.4'
  writeFileSync(join(scratch, 'package.json'), `${JSON.stringify(workspace, null, 2)}\n`)

  run('pnpm', ['install', '--no-frozen-lockfile', '--ignore-scripts', '--config.auto-install-peers=false'], consumer)

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
    if (result.status === 0 || result.signal != null || errors.length === 0
        || errors.some(line => !/app\/app.vue\(\d+,\d+\): error TS2589:/u.test(line))) {
      throw new Error(`Expected the isolated Nitro type-instantiation limit (newsletter=${enabled}):\n${diagnostics}`)
    }
    console.log(`Reproduced upstream TS2589 with newsletter routes ${enabled ? 'enabled' : 'disabled'}`)
  }

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
