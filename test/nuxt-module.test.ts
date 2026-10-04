import { fileURLToPath } from 'node:url'
import '../packages/better-newsletter/src/nuxt.js'
import { loadNuxt } from '@nuxt/kit'
import { describe, expect, it } from 'vitest'

const cwd = fileURLToPath(new URL('./fixtures/nuxt/', import.meta.url))

function registeredRoutes(nuxt: Awaited<ReturnType<typeof loadNuxt>>) {
  const handlers: unknown = Reflect.get(nuxt.options, 'serverHandlers')
  if (!Array.isArray(handlers)) throw new Error('Nuxt did not register server handlers.')
  return handlers.filter((handler: unknown): handler is { route?: string; method?: string } =>
    handler != null && typeof handler === 'object'
  )
}

describe('Nuxt module installation', () => {
  it('installs server-only configuration and one handler mount in a minimal Nuxt app', async () => {
    const nuxt = await loadNuxt({ cwd, dev: true })
    try {
      const routes = registeredRoutes(nuxt).filter(handler =>
        handler.route?.startsWith('/api/newsletter/')
      )
      expect(routes.map(route => route.route)).toEqual([
        '/api/newsletter/**'
      ])
      expect(routes[0]?.method).toBe('post')
      const nitro: unknown = Reflect.get(nuxt.options, 'nitro')
      expect(nitro).toMatchObject({
        virtual: {
          '#better-newsletter-config': expect.any(Function),
          '#better-newsletter-handler': expect.any(Function)
        },
        externals: { inline: [expect.stringContaining('/dist')] }
      })
      expect(nuxt.options.runtimeConfig.public).not.toHaveProperty('storage')
      expect(nuxt.options.runtimeConfig.public).not.toHaveProperty('capabilities')
    } finally {
      await nuxt.close()
    }
  })

  it('moves the single mount without registering individual actions', async () => {
    const nuxt = await loadNuxt({
      cwd,
      dev: true,
      overrides: {
        betterNewsletter: {
          basePath: '/api/signup'
        }
      }
    })
    try {
      expect(registeredRoutes(nuxt).filter(handler => handler.route?.startsWith('/api/signup')))
        .toEqual([expect.objectContaining({ route: '/api/signup/**', method: 'post' })])
      expect(registeredRoutes(nuxt).some(handler => handler.route?.startsWith('/api/newsletter/'))).toBe(false)
    } finally {
      await nuxt.close()
    }
  })
  it('rejects legacy public policy options instead of silently enabling old disabled actions', async () => {
    await expect(loadNuxt({
      cwd,
      dev: true,
      overrides: { betterNewsletter: { routes: { subscribe: false } } as never }
    })).rejects.toThrow('Move betterNewsletter.routes to publicApi.routes')
  })

})
