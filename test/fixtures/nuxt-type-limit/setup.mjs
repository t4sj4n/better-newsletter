import { copyFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const fixture = dirname(fileURLToPath(import.meta.url))
const mode = process.argv[2] ?? 'broad'
if (!['broad', 'narrow'].includes(mode)) throw new Error('Expected broad or narrow')
const routes = Array.from({ length: 300 }, (_, index) =>
  `    '/api/v1/resources-${index}/:id/versions/:versionId/items': { get: { ok: true } }`
)
writeFileSync(join(fixture, 'app/routes.d.ts'), `
import 'nitropack/types'
declare module 'nitropack/types' {
  interface InternalApi {
${routes.join('\n')}
  }
}
export {}
`)
copyFileSync(join(fixture, `app/${mode}.vue.txt`), join(fixture, 'app/app.vue'))
