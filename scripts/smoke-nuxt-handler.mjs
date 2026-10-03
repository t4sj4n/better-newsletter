import { cpSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, URL } from 'node:url'

const fixture = fileURLToPath(new URL('../test/fixtures/nuxt-handler/', import.meta.url))

export function checkNuxtHandler({ scratch, runtimeTarball, run }) {
  const consumer = join(scratch, 'nuxt-handler')
  cpSync(fixture, consumer, { recursive: true })
  const manifest = JSON.parse(readFileSync(join(consumer, 'package.json'), 'utf8'))
  manifest.dependencies['better-newsletter'] = `file:${runtimeTarball}`
  writeFileSync(join(consumer, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  run('pnpm', ['install', '--no-frozen-lockfile', '--ignore-scripts', '--config.auto-install-peers=false'], consumer)
  run('pnpm', ['exec', 'nuxt', 'typecheck'], consumer)
  run('pnpm', ['exec', 'nuxt', 'build'], consumer)
  function inspectBrowserFiles(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) inspectBrowserFiles(path)
      else if (readFileSync(path).includes('PACKED_SERVER_ONLY_SECRET_48')) {
        throw new Error(`Server configuration leaked into browser output: ${path}`)
      }
    }
  }
  inspectBrowserFiles(join(consumer, '.output/public'))
  run('node', ['probe.mjs'], consumer)
}
