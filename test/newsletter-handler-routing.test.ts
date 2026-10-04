import { describe, expect, it, vi } from 'vitest'
import { createNewsletterClient } from '../packages/better-newsletter/src/nuxt/client.js'
import { createNewsletterHandler } from '../packages/better-newsletter/src/nuxt/handler.js'
import { newsletterRoutes } from '../packages/better-newsletter/src/nuxt/routing.js'

describe('package-owned newsletter routing', () => {
  it('uses default paths and POST JSON without Nitro fetch types', async () => {
    const fetcher = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () => new Response(JSON.stringify({ accepted: true })))
    const client = createNewsletterClient(undefined, fetcher)
    const input = { email: 'person@example.com', consent: true as const, consentVersion: 'v1' }
    await client.subscribe(input)
    expect(fetcher).toHaveBeenCalledWith('/api/newsletter/subscribe', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input)
    })
    await client.resendConfirmation({ email: input.email })
    await client.confirm('token')
    await client.unsubscribe('capability')
    await client.unsubscribeAll('capability')
    await client.preferences('capability')
    expect(fetcher.mock.calls.map(call => call[0])).toEqual([
      '/api/newsletter/subscribe', '/api/newsletter/resend-confirmation', '/api/newsletter/confirm',
      '/api/newsletter/unsubscribe', '/api/newsletter/unsubscribe-all', '/api/newsletter/preferences'
    ])
  })

  it('moves actions within the mount and prevents disabled client calls from fetching', async () => {
    const fetcher = vi.fn(async () => new Response('{}'))
    const client = createNewsletterClient({ basePath: '/api/mail', routes: { confirm: '/verify', preferences: false } }, fetcher)
    await client.confirm('token')
    expect(fetcher).toHaveBeenCalledWith('/api/mail/verify', expect.objectContaining({ method: 'POST' }))
    await expect(client.preferences('capability')).rejects.toThrow('disabled')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it.each(['/api/newsletter/', '//example.com', '/api/*', '/api?query', '/api#hash', '/api/../mail', '/'])('rejects invalid mount %s in both client and handler', basePath => {
      expect(() => createNewsletterClient({ basePath })).toThrow('Invalid newsletter base path')
      expect(() => createNewsletterHandler({ basePath })).toThrow('Invalid newsletter base path')
    })

  it('rejects ambiguous, unsafe and unknown action configuration', () => {
    expect(() => newsletterRoutes({ confirm: '/subscribe' })).toThrow('duplicate')
    expect(() => newsletterRoutes({ confirm: '//example.com' })).toThrow('Invalid')
    expect(() => newsletterRoutes({ confirm: '/verify/**' })).toThrow('Invalid')
    expect(() => newsletterRoutes({ constructor: '/constructor' } as never)).toThrow('Unknown')
  })
})
