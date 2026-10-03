import { createServer, IncomingMessage, request as httpRequest, ServerResponse, type Server } from 'node:http'
import { Socket } from 'node:net'
import { createApp, createEvent, defineEventHandler, toNodeListener } from 'h3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CONTACT_STATUSES,
  NEWSLETTER_EVENT_TYPES,
  SUBSCRIPTION_STATUSES
} from '../packages/better-newsletter/src/index.js'
import { createHmacRateLimitKeyProvider } from '../packages/better-newsletter/src/security.js'
import { memoryCapabilities, memoryRateLimiter, memoryAdapter } from '../packages/better-newsletter/src/adapters/memory.js'
import { handleNewsletterRequest } from '../packages/better-newsletter/src/nuxt/handler.js'
import * as newsletterServer from '../packages/better-newsletter/src/nuxt/server.js'
import { newsletterUrl, useBetterNewsletter, type BetterNewsletterServerConfig } from '../packages/better-newsletter/src/nuxt/server.js'
import type { BetterNewsletterModuleOptions, NewsletterRoute } from '../packages/better-newsletter/src/nuxt.js'

const options: Pick<BetterNewsletterModuleOptions, 'defaultAudience' | 'audiences' | 'consent'> = {
  defaultAudience: 'default',
  audiences: { default: { public: true }, product: { public: true }, private: { public: false } },
  consent: { version: '2026-01', source: 'test-form' }
}

let server: Server | undefined
afterEach(async () => {
  if (server) await new Promise<void>((resolve, reject) =>
    server!.close(error => error ? reject(error) : resolve())
  )
  server = undefined
  vi.restoreAllMocks()
})

async function fixture(config: BetterNewsletterServerConfig) {
  const app = createApp()
  for (const action of ['unsubscribeAll', 'unsubscribe', 'subscribe', 'resendConfirmation', 'confirm', 'preferences'] as NewsletterRoute[]) {
    app.use(`/${action}`, defineEventHandler(event =>
      handleNewsletterRequest(event, action, options, config)
    ))
  }
  server = createServer(toNodeListener(app))
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address == null || typeof address === 'string') throw new Error('Missing test address.')
  const base = `http://127.0.0.1:${address.port}`
  return {
    request: async (action: string, body: object, method = 'POST', headers: Record<string, string> = {}) => {
      const response = await fetch(`${base}/${action}`, {
        method,
        ...(method === 'POST' ? {
          headers: { 'content-type': 'application/json', ...headers },
          body: JSON.stringify(body)
        } : {})
      })
      return { status: response.status, body: await response.json() as Record<string, unknown> }
    },
    base
  }
}

function configuration() {
  const storage = memoryAdapter()
  const sent: string[] = []
  const config: BetterNewsletterServerConfig = {
    origin: 'https://newsletter.example',
    storage,
    capabilities: memoryCapabilities(),
    mailer: {
      async sendConfirmation(input) {
        sent.push(input.token)
        return { accepted: true }
      }
    }
  }
  return { config, storage, sent }
}

describe('Nuxt server integration', () => {
  it('exposes trusted confirmation APIs through the request service without sending mail', async () => {
    const { config, sent } = configuration()
    const event = createEvent(new IncomingMessage(new Socket()), new ServerResponse(new IncomingMessage(new Socket())))
    const service = await useBetterNewsletter(event, config)
    const subscription = await service.importSubscription({
      email: 'admin@example.com', status: 'PENDING_CONFIRMATION',
      consent: { version: 'v1', consentedAt: new Date() }
    })
    const input = { subscription: { id: subscription.id } }
    const result = await service.createConfirmationToken({ ...input, eventMetadata: { actorId: 'admin-123' } })
    expect(result).not.toBeNull()
    expect(await service.getConfirmationState(input)).toEqual({
      canCreate: true, reason: null, activeTokenExpiresAt: result!.expiresAt
    })
    expect((await service.listEvents({ email: 'admin@example.com' })).at(-1)).toMatchObject({
      type: 'CONFIRMATION_TOKEN_CREATED', metadata: { actorId: 'admin-123' }
    })
    const page = await service.listSubscriptionEvents({ ...input, limit: 1 })
    expect(page.events[0]).toMatchObject({ type: 'CONFIRMATION_TOKEN_CREATED' })
    expect(page.nextCursor).toEqual(expect.any(String))
    expect(sent).toEqual([])
    expect(await service.confirm({ token: result!.token })).toEqual({ confirmed: true })
  })

  it('rejects malformed requests, missing consent, and non-public audiences before storage', async () => {
    const { config, storage } = configuration()
    const mapper = vi.fn(() => ({ trusted: true }))
    const http = await fixture({ ...config, publicSubscribeMetadata: mapper })
    for (const body of [
      { email: 'person@example.com', consent: false, consentVersion: '2026-01' },
      { email: 'person@example.com', consent: true, consentVersion: 'old' },
      { email: 'person@example.com', consent: true, consentVersion: '2026-01', audience: 'private' },
      { email: 'person@example.com', consent: true, consentVersion: '2026-01', audience: 'unknown' },
      { email: 'invalid', consent: true, consentVersion: '2026-01' }
    ]) {
      expect((await http.request('subscribe', body)).status).toBe(400)
    }
    expect(await storage.transaction(tx => tx.getContactByEmail('person@example.com'))).toBeNull()
    expect((await http.request('subscribe', {
      email: 'person@example.com', consent: true, consentVersion: '2026-01',
      website: 'honeypot'
    })).body).toEqual({ accepted: true })
    expect(await storage.transaction(tx => tx.getContactByEmail('person@example.com'))).toBeNull()
    expect(mapper).not.toHaveBeenCalled()
  })

  it.each(['absent', 'undefined'] as const)('omits metadata with an %s hook and ignores client metadata', async mode => {
    const { config, storage } = configuration()
    const http = await fixture({
      ...config,
      ...(mode === 'undefined' ? { publicSubscribeMetadata: () => undefined } : {})
    })
    expect(await http.request('subscribe', {
      email: 'person@example.com', consent: true, consentVersion: '2026-01',
      metadata: { admin: true, anything: 'forged' }
    })).toEqual({ status: 200, body: { accepted: true } })
    const contact = await storage.transaction(tx => tx.getContactByEmail('person@example.com'))
    expect(contact).not.toBeNull()
    expect(contact).not.toHaveProperty('metadata')
    const events = await storage.transaction(tx => tx.listEvents(contact!.id))
    expect(events.some(event => event.type === NEWSLETTER_EVENT_TYPES.SIGNED_UP)).toBe(true)
    expect(JSON.stringify(events)).not.toContain('forged')
    expect(events.every(event => !Object.hasOwn(event.metadata, 'admin'))).toBe(true)
  })

  it.each([false, true])('persists only host-selected metadata (async=%s) before security context', async asynchronous => {
    const { config, storage } = configuration()
    const calls: string[] = []
    const select: NonNullable<BetterNewsletterServerConfig['publicSubscribeMetadata']> = (_event, body) => {
      calls.push('metadata')
      return { trusted: true, signupSource: body.source === 'pricing' ? 'pricing' : 'other' }
    }
    const mapper = vi.fn(asynchronous
      ? async (...args: Parameters<typeof select>) => select(...args)
      : select)
    const http = await fixture({
      ...config,
      publicSubscribeMetadata: mapper,
      securityContext: () => { calls.push('security'); return { captcha: 'transient' } }
    })
    expect(await http.request('subscribe', {
      email: 'person@example.com', consent: true, consentVersion: '2026-01',
      source: 'pricing', metadata: { admin: true, anything: 'forged' }
    })).toEqual({ status: 200, body: { accepted: true } })
    expect(mapper).toHaveBeenCalledTimes(1)
    expect(calls).toEqual(['metadata', 'security'])
    const contact = await storage.transaction(tx => tx.getContactByEmail('person@example.com'))
    expect(contact?.metadata).toBeUndefined()
    expect(JSON.stringify(contact)).not.toContain('captcha')
    expect(await storage.transaction(tx => tx.listSubscriptions(contact!.id))).toHaveLength(1)
    const signupEvents = (await storage.transaction(tx => tx.listEvents(contact!.id)))
      .filter(event => event.type === NEWSLETTER_EVENT_TYPES.SIGNED_UP)
    expect(signupEvents.map(event => event.metadata)).toEqual([{
      trusted: true, signupSource: 'pricing', audienceKey: 'default',
      consentVersion: '2026-01', source: 'test-form'
    }])
    await http.request('resendConfirmation', { email: 'person@example.com' })
    expect(mapper).toHaveBeenCalledTimes(1)
  })

  it('skips host hooks and all storage writes for honeypot requests', async () => {
    const { config, storage, sent } = configuration()
    const mapper = vi.fn(() => ({ trusted: true }))
    const securityContext = vi.fn()
    const transaction = vi.spyOn(storage, 'transaction')
    const http = await fixture({ ...config, publicSubscribeMetadata: mapper, securityContext })
    expect(await http.request('subscribe', {
      email: 'person@example.com', consent: true, consentVersion: '2026-01', website: 'bot'
    })).toEqual({ status: 200, body: { accepted: true } })
    expect(mapper).not.toHaveBeenCalled()
    expect(securityContext).not.toHaveBeenCalled()
    expect(transaction).not.toHaveBeenCalled()
    expect(sent).toEqual([])
    expect(await storage.transaction(tx => tx.getContactByEmail('person@example.com'))).toBeNull()
  })

  it('maps once and passes the same immutable metadata to every audience input', async () => {
    const { config, storage } = configuration()
    const metadata = Object.freeze({ trusted: true, context: Object.freeze({ placement: 'pricing' }) })
    const mapper = vi.fn(() => metadata)
    const subscribe = vi.spyOn(newsletterServer, 'subscribeNewsletterAudiences')
    const http = await fixture({ ...config, publicSubscribeMetadata: mapper })
    expect(await http.request('subscribe', {
      email: 'person@example.com', consent: true, consentVersion: '2026-01',
      audiences: ['default', 'product']
    })).toEqual({ status: 200, body: { accepted: true } })
    expect(mapper).toHaveBeenCalledTimes(1)
    expect(subscribe).toHaveBeenCalledTimes(1)
    const inputs = subscribe.mock.calls[0]![1]
    expect(inputs.map(input => input.audience)).toEqual(['default', 'product'])
    expect(inputs.every(input => input.metadata === metadata)).toBe(true)
    expect(metadata).toEqual({ trusted: true, context: { placement: 'pricing' } })
    const contact = await storage.transaction(tx => tx.getContactByEmail('person@example.com'))
    expect(contact?.metadata).toBeUndefined()
    const subscriptions = await storage.transaction(tx => tx.listSubscriptions(contact!.id))
    expect(subscriptions.map(subscription => subscription.audienceKey)).toEqual(['default', 'product'])
    const signups = (await storage.transaction(tx => tx.listEvents(contact!.id)))
      .filter(event => event.type === NEWSLETTER_EVENT_TYPES.SIGNED_UP)
    expect(signups.map(event => event.metadata)).toEqual(['default', 'product'].map(audienceKey => ({
      ...metadata, audienceKey, consentVersion: '2026-01', source: 'test-form'
    })))
    expect(signups[0]!.metadata).not.toBe(signups[1]!.metadata)
    const service = await useBetterNewsletter({ context: {} } as Parameters<typeof useBetterNewsletter>[0], config)
    const capability = await service.createUnsubscribeCapability({ email: 'person@example.com', all: true })
    await http.request('unsubscribeAll', { capability })
    await http.request('subscribe', {
      email: 'person@example.com', consent: true, consentVersion: '2026-01',
      audiences: ['default', 'product']
    })
    expect(mapper).toHaveBeenCalledTimes(2)
    const events = await storage.transaction(tx => tx.listEvents(contact!.id))
    const resubscribes = events.filter(event => event.type === NEWSLETTER_EVENT_TYPES.RESUBSCRIBED)
    expect(resubscribes.map(event => event.metadata)).toEqual(signups.map(event => event.metadata))
    expect(resubscribes[0]!.metadata).not.toBe(resubscribes[1]!.metadata)
    expect(events.filter(event => event.type === NEWSLETTER_EVENT_TYPES.SIGNED_UP)).toEqual(signups)
    expect((await service.getContact({ email: 'person@example.com' }))?.metadata).toBeUndefined()
  })

  it('limits the request body by bytes while streaming, including chunked requests', async () => {
    const { config } = configuration()
    const http = await fixture(config)
    const input = {
      email: 'person@example.com', consent: true, consentVersion: '2026-01'
    }
    const valid = JSON.stringify(input)
    const boundary = valid.padEnd(8192, ' ')
    const accepted = await fetch(`${http.base}/subscribe`, {
      method: 'POST',
      body: boundary,
      headers: { 'content-type': 'application/json' }
    })
    expect(accepted.status).toBe(200)

    const oversized = await fetch(`${http.base}/subscribe`, {
      method: 'POST',
      body: JSON.stringify({ ...input, note: 'é'.repeat(4096) }),
      headers: { 'content-type': 'application/json' }
    })
    expect(oversized.status).toBe(400)

    const pending = httpRequest(`${http.base}/subscribe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' }
    })
    try {
      const status = new Promise<number>((resolve, reject) => {
        pending.on('response', response => {
          response.resume()
          response.on('end', () => resolve(response.statusCode ?? 0))
          response.on('error', reject)
        })
        pending.on('error', reject)
      })
      pending.write('x'.repeat(8193))
      expect(await status).toBe(400)
    } finally {
      pending.destroy()
    }
  })

  it('reads web request bodies without relying on the Node request stream', async () => {
    const { config } = configuration()
    const incoming = new IncomingMessage(new Socket())
    incoming.method = 'POST'
    const event = createEvent(incoming, new ServerResponse(incoming))
    event.web = {
      request: new Request('http://localhost/subscribe', {
        method: 'POST',
        body: JSON.stringify({
          email: 'person@example.com', consent: true, consentVersion: '2026-01'
        })
      })
    }
    await expect(handleNewsletterRequest(event, 'subscribe', options, config))
      .resolves.toEqual({ accepted: true })
  })

  it('uses explicit POST for mutation and preserves neutral public responses', async () => {
    const { config, storage, sent } = configuration()
    const http = await fixture(config)
    expect((await http.request('confirm', {}, 'GET')).status).toBe(405)
    expect((await http.request('unsubscribe', {}, 'GET')).status).toBe(405)
    const subscribe = {
      email: 'person@example.com', consent: true, consentVersion: '2026-01',
      audiences: ['default', 'product']
    }
    expect(await http.request('subscribe', subscribe)).toEqual({ status: 200, body: { accepted: true } })
    expect(sent).toHaveLength(2)
    expect((await http.request('resendConfirmation', { email: 'unknown@example.com' })).body)
      .toEqual({ accepted: true })
    expect((await http.request('resendConfirmation', { email: 'person@example.com' })).body)
      .toEqual({ accepted: true })
    expect((await http.request('confirm', { token: sent[0] })).body).toEqual({ confirmed: true })
    const contact = await storage.transaction(tx => tx.getContactByEmail('person@example.com'))
    expect(contact).not.toBeNull()
    const subscriptions = await storage.transaction(tx => tx.listSubscriptions(contact!.id))
    expect(subscriptions.map(item => item.status)).toContain(SUBSCRIPTION_STATUSES.ACTIVE)
    expect(subscriptions.map(item => item.status)).toContain(SUBSCRIPTION_STATUSES.PENDING_CONFIRMATION)
    expect((await http.request('confirm', { token: sent[1] })).body).toEqual({ confirmed: true })
  })

  it('restricts preference listing to dedicated signed capabilities and supports per-audience/all opt-out', async () => {
    const { config } = configuration()
    const http = await fixture(config)
    await http.request('subscribe', {
      email: 'person@example.com', consent: true, consentVersion: '2026-01', audiences: ['default', 'product']
    })
    const event = { context: {} } as Parameters<typeof useBetterNewsletter>[0]
    const service = await useBetterNewsletter(event, config)
    expect(service).not.toHaveProperty('storage')
    expect(service).not.toHaveProperty('capabilities')
    expect((await http.request('preferences', { capability: 'invalid' })).body)
      .toEqual({ subscriptions: null })
    const manage = await service.createManagePreferencesCapability({ email: 'person@example.com' })
    const all = await service.createUnsubscribeCapability({ email: 'person@example.com', all: true })
    expect(manage).toBeTruthy()
    expect((await http.request('preferences', { capability: all })).body)
      .toEqual({ subscriptions: null })
    const listed = (await http.request('preferences', { capability: manage })).body.subscriptions as
      { audience: string; unsubscribeCapability: string }[]
    expect(listed).toHaveLength(2)
    expect((await http.request('unsubscribe', { capability: listed[0]!.unsubscribeCapability })).body)
      .toEqual({ unsubscribed: true })
    expect((await service.getSubscription({ email: 'person@example.com', audience: listed[1]!.audience }))?.status)
      .toBe(SUBSCRIPTION_STATUSES.PENDING_CONFIRMATION)
    const target = await config.capabilities.resolveUnsubscribeCapability(all!)
    expect(target).toMatchObject({ scope: 'ALL' })
    expect((await service.getContact({ email: 'person@example.com' }))?.capabilityGeneration)
      .toBe(target?.scope === 'ALL' ? target.capabilityGeneration : -1)
    expect((await http.request('unsubscribeAll', { capability: all })).body)
      .toEqual({ unsubscribed: true })
    expect((await service.listSubscriptions({ email: 'person@example.com' }))
      .every(item => item.status === SUBSCRIPTION_STATUSES.UNSUBSCRIBED)).toBe(true)
  })

  it('awaits delivery without platform waitUntil and attaches work when supported', async () => {
    const { config, sent } = configuration()
    let release: (() => void) | undefined
    const blocked = new Promise<void>(resolve => { release = resolve })
    config.mailer.sendConfirmation = async input => {
      await blocked
      sent.push(input.token)
      return { accepted: true }
    }
    const http = await fixture(config)
    let settled = false
    const request = http.request('subscribe', {
      email: 'person@example.com', consent: true, consentVersion: '2026-01'
    }).then(result => { settled = true; return result })
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(settled).toBe(false)
    release!()
    expect((await request).body).toEqual({ accepted: true })
    expect(sent).toHaveLength(1)
  })

  it('attaches work to platform waitUntil and reclaims an expired lease after an interrupted delivery', async () => {
    const { config } = configuration()
    let now = Date.parse('2026-09-28T08:00:00Z')
    let deliveries = 0
    const host: BetterNewsletterServerConfig = {
      ...config,
      clock: { now: () => new Date(now) },
      logger: { error: vi.fn() },
      mailer: {
        async sendConfirmation() {
          deliveries += 1
          if (deliveries === 1) throw new Error('Simulated interrupted provider response.')
          return { accepted: true }
        }
      }
    }
    async function request(send: (service: Awaited<ReturnType<typeof useBetterNewsletter>>) => Promise<unknown>) {
      const pending: Promise<unknown>[] = []
      const incoming = new IncomingMessage(new Socket())
      const event = createEvent(incoming, new ServerResponse(incoming))
      event.context.waitUntil = (task: Promise<unknown>) => { pending.push(task) }
      const service = await useBetterNewsletter(event, host)
      await send(service)
      expect(pending).toHaveLength(1)
      await Promise.all(pending)
      return service
    }
    const service = await request(service =>
      service.subscribe({ email: 'person@example.com', consent: { granted: true, version: '2026-01' } })
    )
    expect(deliveries).toBe(1)
    expect((await service.getSubscription({ email: 'person@example.com' }))?.status)
      .toBe(SUBSCRIPTION_STATUSES.PENDING_CONFIRMATION)
    now += 5 * 60_000 + 1
    await request(service => service.resendConfirmation({ email: 'person@example.com' }))
    expect(deliveries).toBe(2)
    expect((await service.listEvents({ email: 'person@example.com' }))
      .some(item => item.type === NEWSLETTER_EVENT_TYPES.CONFIRMATION_SENT)).toBe(true)
  })

  it('awaits fallback delivery in custom handlers without requiring an explicit flush', async () => {
    const { config } = configuration()
    let release: (() => void) | undefined
    const blocked = new Promise<void>(resolve => { release = resolve })
    const send = vi.fn(async () => {
      await blocked
      return { accepted: true as const }
    })
    const incoming = new IncomingMessage(new Socket())
    const event = createEvent(incoming, new ServerResponse(incoming))
    const service = await useBetterNewsletter(event, { ...config, mailer: { sendConfirmation: send } })
    let settled = false
    const request = service.subscribe({
      email: 'person@example.com',
      consent: { granted: true, version: '2026-01' }
    }).then(() => { settled = true })
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    expect(settled).toBe(false)
    release!()
    await request
    expect(settled).toBe(true)
  })

  it('composes independent opaque email and trusted-client limits; ignores forwarded headers by default', async () => {
    const { config } = configuration()
    const emailLimiter = memoryRateLimiter()
    const clientLimiter = memoryRateLimiter()
    const consumed = vi.spyOn(clientLimiter, 'consume')
    const identity = vi.fn(() => 'trusted-client')
    const guarded: BetterNewsletterServerConfig = {
      ...config,
      rateLimiter: emailLimiter,
      rateLimitKeyProvider: createHmacRateLimitKeyProvider({ secret: 'opaque-email-key-0123456789abcdef0123456789' }),
      rateLimits: { subscribe: { limit: 2, windowMs: 60_000 }, resendConfirmation: { limit: 2, windowMs: 60_000 } },
      trustedClientIdentity: identity,
      clientRateLimit: {
        secret: 'opaque-client-key-0123456789abcdef0123456789',
        limiter: clientLimiter,
        policies: { subscribe: { limit: 1, windowMs: 60_000 }, resendConfirmation: { limit: 1, windowMs: 60_000 } }
      }
    }
    const http = await fixture(guarded)
    const body = (email: string) => ({ email, consent: true, consentVersion: '2026-01' })
    expect((await http.request('subscribe', body('a@example.com'))).body).toEqual({ accepted: true })
    expect((await http.request('subscribe', body('b@example.com'), 'POST', {
      'x-forwarded-for': 'spoofed-client'
    })).body).toEqual({ accepted: true })
    expect(consumed).toHaveBeenCalledTimes(2)
    expect(consumed.mock.calls[1]?.[0].key).toBe(consumed.mock.calls[0]?.[0].key)
    expect(consumed.mock.calls[0]?.[0].key).toMatch(/^[0-9a-f]{64}$/u)
    expect(consumed.mock.calls[0]?.[0].key).not.toContain('trusted-client')
    expect(identity).toHaveBeenCalledTimes(2)
    expect((await http.request('resendConfirmation', { email: 'a@example.com' })).body)
      .toEqual({ accepted: true })
    expect(consumed.mock.calls[2]?.[0].action).toBe('resend-confirmation')
  })

  it('enforces an email bucket across independent trusted clients', async () => {
    const { config } = configuration()
    let client = 'trusted-a'
    const limiter = memoryRateLimiter()
    const guarded: BetterNewsletterServerConfig = {
      ...config,
      rateLimiter: limiter,
      rateLimitKeyProvider: createHmacRateLimitKeyProvider({
        secret: 'opaque-email-key-0123456789abcdef0123456789'
      }),
      rateLimits: { subscribe: { limit: 1, windowMs: 60_000 } },
      trustedClientIdentity: () => client,
      clientRateLimit: {
        secret: 'opaque-client-key-0123456789abcdef0123456789',
        limiter: memoryRateLimiter(),
        policies: { subscribe: { limit: 10, windowMs: 60_000 } }
      }
    }
    const http = await fixture(guarded)
    const body = { email: 'person@example.com', consent: true, consentVersion: '2026-01' }
    expect((await http.request('subscribe', body)).body).toEqual({ accepted: true })
    client = 'trusted-b'
    expect((await http.request('subscribe', body)).body).toEqual({ accepted: true })
    const service = await useBetterNewsletter({ context: {} } as Parameters<typeof useBetterNewsletter>[0], config)
    expect((await service.listEvents({ email: 'person@example.com' }))
      .filter(item => item.type === NEWSLETTER_EVENT_TYPES.SIGNED_UP)).toHaveLength(1)
  })

  it('passes application-owned CAPTCHA context to the generic guard without storing it', async () => {
    const { config, storage } = configuration()
    const verify = vi.fn(async (input: { context?: unknown }) => ({
      allowed: (input.context as { captcha?: string } | undefined)?.captcha === 'valid'
    }))
    const guarded: BetterNewsletterServerConfig = {
      ...config,
      abuseGuard: { verify },
      securityContext: (_event, body) => ({ captcha: body.captcha })
    }
    const http = await fixture(guarded)
    const body = { email: 'person@example.com', consent: true, consentVersion: '2026-01' }
    expect((await http.request('subscribe', { ...body, captcha: 'invalid' })).body)
      .toEqual({ accepted: true })
    expect(await storage.transaction(tx => tx.getContactByEmail(body.email))).toBeNull()
    expect((await http.request('subscribe', { ...body, captcha: 'valid' })).body)
      .toEqual({ accepted: true })
    expect(verify).toHaveBeenCalledWith(expect.objectContaining({
      action: 'subscribe', context: { captcha: 'valid' }
    }))
    const contact = await storage.transaction(tx => tx.getContactByEmail(body.email))
    expect(contact).not.toBeNull()
    expect(JSON.stringify(contact)).not.toContain('captcha')
  })

  it.each(['abuse', 'email limit', 'guard error'])(
    'does not subscribe any audience when a later audience fails its %s check',
    async failure => {
      const { config, storage, sent } = configuration()
      const verify = vi.fn(async (input: { audienceKey: string }) => {
        if (input.audienceKey === 'product' && failure === 'guard error') {
          throw new Error('Guard unavailable')
        }
        return { allowed: failure !== 'abuse' || input.audienceKey !== 'product' }
      })
      const consume = vi.fn(async () => ({ allowed: consume.mock.calls.length < 2 }))
      const http = await fixture({
        ...config,
        abuseGuard: { verify },
        ...(failure === 'email limit' ? {
          rateLimiter: { consume },
          rateLimitKeyProvider: { createKey: async input => input.audienceKey }
        } : {}),
      })
      const result = await http.request('subscribe', {
        email: 'person@example.com', consent: true, consentVersion: '2026-01',
        audiences: ['default', 'product']
      })
      if (failure === 'guard error') expect(result.status).toBe(500)
      else expect(result).toEqual({ status: 200, body: { accepted: true } })
      expect(verify.mock.calls.map(([input]) => input.audienceKey)).toEqual(['default', 'product'])
      expect(await storage.transaction(tx => tx.getContactByEmail('person@example.com'))).toBeNull()
      expect(sent).toHaveLength(0)
    }
  )

  it('consumes a shared client limit once for a multi-audience request', async () => {
    const { config, sent } = configuration()
    const clientLimiter = memoryRateLimiter()
    const clientConsume = vi.spyOn(clientLimiter, 'consume')
    const audienceConsume = vi.fn(async (input: { key: string }) => ({ allowed: input.key.length > 0 }))
    const http = await fixture({
      ...config,
      rateLimiter: { consume: audienceConsume },
      rateLimitKeyProvider: { createKey: async input => input.audienceKey },
      trustedClientIdentity: () => 'trusted-client',
      clientRateLimit: {
        secret: 'opaque-client-key-0123456789abcdef0123456789',
        limiter: clientLimiter,
        policies: { subscribe: { limit: 1, windowMs: 60_000 } }
      }
    })

    expect(await http.request('subscribe', {
      email: 'person@example.com', consent: true, consentVersion: '2026-01',
      audiences: ['default', 'product']
    })).toEqual({ status: 200, body: { accepted: true } })
    expect(clientConsume).toHaveBeenCalledTimes(1)
    expect(audienceConsume.mock.calls.map(([input]) => input.key)).toEqual(['default', 'product'])
    expect(sent).toHaveLength(2)
  })

  it('checks every audience exactly once before creating subscriptions', async () => {
    const { config, storage, sent } = configuration()
    const verify = vi.fn(async () => {
      expect(await storage.transaction(tx => tx.getContactByEmail('person@example.com'))).toBeNull()
      expect(sent).toHaveLength(0)
      return { allowed: true }
    })
    const consume = vi.fn(async () => ({ allowed: true }))
    const http = await fixture({
      ...config,
      abuseGuard: { verify },
      rateLimiter: { consume },
      rateLimitKeyProvider: { createKey: async input => input.audienceKey }
    })
    expect(await http.request('subscribe', {
      email: 'person@example.com', consent: true, consentVersion: '2026-01',
      audiences: ['default', 'product']
    })).toEqual({ status: 200, body: { accepted: true } })
    expect(verify).toHaveBeenCalledTimes(2)
    expect(consume).toHaveBeenCalledTimes(2)
    expect(sent).toHaveLength(2)
    const contact = await storage.transaction(tx => tx.getContactByEmail('person@example.com'))
    expect(await storage.transaction(tx => tx.listSubscriptions(contact!.id))).toHaveLength(2)
  })

  it('uses a trusted origin for links and leaves subject linking to application code', async () => {
    const { config } = configuration()
    expect(newsletterUrl(config.origin, '/confirm', 'a&b'))
      .toBe('https://newsletter.example/confirm?token=a%26b')
    expect(() => newsletterUrl(config.origin, '//evil.example', 'token')).toThrow()
    const http = await fixture(config)
    await http.request('subscribe', { email: 'person@example.com', consent: true, consentVersion: '2026-01' })
    const service = await useBetterNewsletter({ context: {} } as Parameters<typeof useBetterNewsletter>[0], config)
    expect((await service.getContact({ email: 'person@example.com' }))?.subject).toBeNull()
    await service.linkSubject({ email: 'person@example.com', subject: { namespace: 'app', id: 'opaque-1' } })
    expect((await service.getContact({ email: 'person@example.com' }))?.subject)
      .toEqual({ namespace: 'app', id: 'opaque-1' })
    expect((await service.listEvents({ email: 'person@example.com' }))
      .some(item => item.type === NEWSLETTER_EVENT_TYPES.CONFIRMED)).toBe(false)
    expect((await service.getContact({ email: 'person@example.com' }))?.status)
      .toBe(CONTACT_STATUSES.ENABLED)
  })
})
