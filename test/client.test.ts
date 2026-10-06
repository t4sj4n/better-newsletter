import { describe, expect, it, vi } from 'vitest'
import {
  createNewsletterClient,
  type NewsletterClient,
  type NewsletterClientPreferencesResult,
  type NewsletterClientSubscribeInput,
  type NewsletterRoute,
  type NewsletterRoutes,
  type NewsletterRoutingOptions,
  type Fetcher
} from '../packages/better-newsletter/src/client.js'
import {
  createNewsletterClient as createNewsletterClientFromNuxtAlias
} from '../packages/better-newsletter/src/nuxt/client.js'

describe('framework-neutral browser client', () => {
  it('exports the identical function reference from /client and the /nuxt/client alias', () => {
    expect(createNewsletterClient).toBeTypeOf('function')
    expect(createNewsletterClientFromNuxtAlias).toBe(createNewsletterClient)
    const options: NewsletterRoutingOptions = { basePath: '/api/newsletter' }
    const route: NewsletterRoute = 'subscribe'
    const routes: NewsletterRoutes = { subscribe: '/sub', resendConfirmation: false, confirm: false, unsubscribe: false, unsubscribeAll: false, preferences: false }
    const stalePreferences: NewsletterClientPreferencesResult = { subscriptions: null }
    void [options, route, routes, stalePreferences]
  })

  it('uses default basePath and routes for all six public actions', async () => {
    const fetcher = vi.fn<Fetcher>(async (url) => {
      if (url.endsWith('/confirm')) return new Response(JSON.stringify({ confirmed: true }))
      if (url.endsWith('/unsubscribe') || url.endsWith('/unsubscribe-all')) {
        return new Response(JSON.stringify({ unsubscribed: true }))
      }
      if (url.endsWith('/preferences')) return new Response(JSON.stringify({ subscriptions: null }))
      return new Response(JSON.stringify({ accepted: true }))
    })
    const client: NewsletterClient = createNewsletterClient(undefined, fetcher)

    // 1. subscribe
    const subscribeInput = {
      email: 'user@example.com',
      audience: 'updates',
      consent: true as const,
      consentVersion: 'v1'
    }
    const subscribeResult = await client.subscribe(subscribeInput)
    expect(subscribeResult).toEqual({ accepted: true })
    expect(fetcher).toHaveBeenLastCalledWith('/api/newsletter/subscribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(subscribeInput)
    })

    // 2. resend confirmation
    const resendInput = { email: 'user@example.com', audience: 'updates' }
    const resendResult = await client.resendConfirmation(resendInput)
    expect(resendResult).toEqual({ accepted: true })
    expect(fetcher).toHaveBeenLastCalledWith('/api/newsletter/resend-confirmation', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(resendInput)
    })

    // 3. confirm
    const confirmResult = await client.confirm('test-token-123')
    expect(confirmResult).toEqual({ confirmed: true })
    expect(fetcher).toHaveBeenLastCalledWith('/api/newsletter/confirm', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'test-token-123' })
    })

    // 4. unsubscribe
    const unsubscribeResult = await client.unsubscribe('cap-unsub-123')
    expect(unsubscribeResult).toEqual({ unsubscribed: true })
    expect(fetcher).toHaveBeenLastCalledWith('/api/newsletter/unsubscribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ capability: 'cap-unsub-123' })
    })

    // 5. unsubscribeAll
    const unsubscribeAllResult = await client.unsubscribeAll('cap-unsub-all-123')
    expect(unsubscribeAllResult).toEqual({ unsubscribed: true })
    expect(fetcher).toHaveBeenLastCalledWith('/api/newsletter/unsubscribe-all', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ capability: 'cap-unsub-all-123' })
    })

    // 6. preferences
    const preferencesResult = await client.preferences('cap-pref-123')
    expect(preferencesResult).toEqual({ subscriptions: null })
    expect(fetcher).toHaveBeenLastCalledWith('/api/newsletter/preferences', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ capability: 'cap-pref-123' })
    })

    expect(fetcher.mock.calls.map(call => call[0])).toEqual([
      '/api/newsletter/subscribe',
      '/api/newsletter/resend-confirmation',
      '/api/newsletter/confirm',
      '/api/newsletter/unsubscribe',
      '/api/newsletter/unsubscribe-all',
      '/api/newsletter/preferences'
    ])
  })

  it('supports custom basePath and custom action routes', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ confirmed: true })))
    const client = createNewsletterClient({
      basePath: '/api/v2/mail',
      routes: {
        confirm: '/verify',
        unsubscribe: '/opt-out'
      }
    }, fetcher)

    await client.confirm('token-xyz')
    expect(fetcher).toHaveBeenCalledWith('/api/v2/mail/verify', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ token: 'token-xyz' })
    }))

    await client.unsubscribe('cap-xyz')
    expect(fetcher).toHaveBeenCalledWith('/api/v2/mail/opt-out', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ capability: 'cap-xyz' })
    }))
  })

  it.each([createNewsletterClient, createNewsletterClientFromNuxtAlias])(
    'serializes typed subscribe metadata through the existing request path (%#)', async createClient => {
      const fetcher = vi.fn<Fetcher>(async () => new Response(JSON.stringify({ accepted: true })))
      const client = createClient(undefined, fetcher)
      const input: NewsletterClientSubscribeInput = {
        email: 'user@example.com',
        consent: true,
        consentVersion: 'v1',
        metadata: {
          signupSource: 'LANDING_PAGE',
          campaign: 'launch',
          context: { placements: ['hero', 'footer'], variant: null },
          experiment: 2,
          returning: false
        }
      }

      expect(await client.subscribe(input)).toEqual({ accepted: true })
      expect(fetcher).toHaveBeenCalledExactlyOnceWith('/api/newsletter/subscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input)
      })
    }
  )

  it('prevents disabled routes from sending HTTP requests', async () => {
    const fetcher = vi.fn(async () => new Response('{}'))
    const client = createNewsletterClient({
      routes: {
        preferences: false,
        unsubscribeAll: false
      }
    }, fetcher)

    await expect(client.preferences('cap')).rejects.toThrow('This newsletter route is disabled.')
    await expect(client.unsubscribeAll('cap')).rejects.toThrow('This newsletter route is disabled.')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('rejects on non-2xx HTTP responses', async () => {
    const fetcher = vi.fn(async () => new Response('Bad Request', { status: 400, statusText: 'Bad Request' }))
    const client = createNewsletterClient(undefined, fetcher)

    await expect(client.confirm('invalid-token')).rejects.toThrow('Newsletter request failed (400).')
  })

  it('validates basePath format', () => {
    expect(() => createNewsletterClient({ basePath: '/api/newsletter/' })).toThrow('Invalid newsletter base path')
    expect(() => createNewsletterClient({ basePath: 'api/newsletter' })).toThrow('Invalid newsletter base path')
    expect(() => createNewsletterClient({ basePath: '//evil.com' })).toThrow('Invalid newsletter base path')
    expect(() => createNewsletterClient({ basePath: '/' })).toThrow('Invalid newsletter base path')
  })
})
