import { fileURLToPath } from 'node:url'
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
  it('installs server-only configuration and default POST routes in a minimal Nuxt app', async () => {
    const nuxt = await loadNuxt({ cwd, dev: true })
    try {
      const routes = registeredRoutes(nuxt).filter(handler =>
        handler.route?.startsWith('/api/newsletter/')
      )
      expect(routes.map(route => route.route).sort()).toEqual([
        '/api/newsletter/confirm',
        '/api/newsletter/preferences',
        '/api/newsletter/resend-confirmation',
        '/api/newsletter/subscribe',
        '/api/newsletter/unsubscribe',
        '/api/newsletter/unsubscribe-all'
      ].sort())
      expect(routes.every(route => route.method === 'post')).toBe(true)
      const nitro: unknown = Reflect.get(nuxt.options, 'nitro')
      expect(nitro).toMatchObject({
        virtual: { '#better-newsletter-config': expect.any(Function) },
        externals: { inline: [expect.stringContaining('/dist')] }
      })
      expect(nuxt.options.runtimeConfig.public).not.toHaveProperty('storage')
      expect(nuxt.options.runtimeConfig.public).not.toHaveProperty('capabilities')
    } finally {
      await nuxt.close()
    }
  })

  it('accepts route overrides and disables individual endpoints', async () => {
    const nuxt = await loadNuxt({
      cwd,
      dev: true,
      overrides: {
        betterNewsletter: {
          routes: {
            subscribe: '/api/signup',
            resendConfirmation: false
          }
        }
      }
    })
    try {
      expect(registeredRoutes(nuxt).some(handler =>
        handler.route === '/api/signup' && handler.method === 'post'
      )).toBe(true)
      expect(registeredRoutes(nuxt).some(handler =>
        handler.route === '/api/newsletter/resend-confirmation'
      )).toBe(false)
    } finally {
      await nuxt.close()
    }
  })
})
