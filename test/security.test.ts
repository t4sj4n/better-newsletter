import { describe, expect, it, vi } from 'vitest'
import {
  CONFIRMATION_REPLACEMENT_STRATEGIES,
  NEWSLETTER_ERROR_CODES,
  SUBSCRIPTION_STATUSES,
  createHmacRateLimitKeyProvider,
  createNewsletter,
  createSecureCapabilities,
  secureTokenGenerator,
  sha256Digest
} from '../src/index.js'
import {
  memoryConfirmationTokenStore,
  memoryRateLimiter,
  memoryStorage
} from '../src/memory.js'

const secret = '0123456789abcdef0123456789abcdef'
const now = new Date('2026-09-28T10:00:00.000Z')

function secureCapabilities() {
  const confirmationStore = memoryConfirmationTokenStore()
  const capabilities = createSecureCapabilities({ hmacSecret: secret })

  return { capabilities, confirmationStore }
}

describe('secure token primitives', () => {
  it('generates 32-byte opaque tokens with Web Crypto', () => {
    const first = secureTokenGenerator.generate()
    const second = secureTokenGenerator.generate()

    expect(first).toMatch(/^[0-9a-f]{64}$/u)
    expect(second).toMatch(/^[0-9a-f]{64}$/u)
    expect(second).not.toBe(first)
  })

  it('persists only confirmation-token digests and consumes atomically once', async () => {
    const { capabilities, confirmationStore } = secureCapabilities()
    const rawToken = 'raw-confirmation-token'

    await capabilities.replaceConfirmation({
      token: rawToken,
      contactId: 'contact-1',
      subscriptionId: 'subscription-1',
      lifecycleGeneration: 1,
      issuedAt: now,
      expiresAt: new Date(now.getTime() + 60_000),
      replacementStrategy: CONFIRMATION_REPLACEMENT_STRATEGIES.REPLACE_PREVIOUS,
      maxActiveTokens: 1
    }, confirmationStore)

    const stored = confirmationStore.snapshot()
    expect(stored).toHaveLength(1)
    expect(stored[0]?.digest).toBe(await sha256Digest(rawToken))
    expect(JSON.stringify(stored)).not.toContain(rawToken)

    const results = await Promise.all([
      capabilities.consumeConfirmation(rawToken, now, confirmationStore),
      capabilities.consumeConfirmation(rawToken, now, confirmationStore)
    ])

    expect(results.filter(Boolean)).toHaveLength(1)
    expect(results.filter(result => result == null)).toHaveLength(1)
  })

  it('rejects expired confirmation tokens', async () => {
    const { capabilities, confirmationStore } = secureCapabilities()

    await capabilities.replaceConfirmation({
      token: 'expired-token',
      contactId: 'contact-1',
      subscriptionId: 'subscription-1',
      lifecycleGeneration: 1,
      issuedAt: now,
      expiresAt: new Date(now.getTime() + 1_000),
      replacementStrategy: CONFIRMATION_REPLACEMENT_STRATEGIES.REPLACE_PREVIOUS,
      maxActiveTokens: 1
    }, confirmationStore)

    await expect(capabilities.consumeConfirmation(
      'expired-token',
      new Date(now.getTime() + 1_001),
      confirmationStore
    )).resolves.toBeNull()
  })

  it('retains at most the configured number of resend tokens', async () => {
    const { capabilities, confirmationStore } = secureCapabilities()

    for (const [index, token] of ['token-1', 'token-2', 'token-3'].entries()) {
      const issuedAt = new Date(now.getTime() + index * 1_000)
      await capabilities.replaceConfirmation({
        token,
        contactId: 'contact-1',
        subscriptionId: 'subscription-1',
        lifecycleGeneration: 1,
        issuedAt,
        expiresAt: new Date(now.getTime() + 60_000),
        replacementStrategy:
          CONFIRMATION_REPLACEMENT_STRATEGIES.RETAIN_PREVIOUS_UNTIL_EXPIRY,
        maxActiveTokens: 2
      }, confirmationStore)
    }

    const active = confirmationStore.snapshot().filter(record =>
      record.consumedAt == null && record.revokedAt == null
    )
    expect(active).toHaveLength(2)
    await expect(capabilities.consumeConfirmation('token-1', now, confirmationStore))
      .resolves.toBeNull()
    await expect(capabilities.consumeConfirmation('token-2', now, confirmationStore))
      .resolves.toMatchObject({ subscriptionId: 'subscription-1' })
  })

  it('signs unsubscribe purpose, target and generation without a nonce store', async () => {
    const { capabilities } = secureCapabilities()

    const single = await capabilities.issueUnsubscribeCapability({
      contactId: 'contact-1',
      subscriptionId: 'subscription-1',
      lifecycleGeneration: 1
    })
    const all = await capabilities.issueUnsubscribeAllCapability({
      contactId: 'contact-1',
      capabilityGeneration: 1
    })

    expect(single).not.toContain('contact-1')
    expect(single).not.toContain('subscription-1')
    expect(single).not.toBe(all)
    await expect(capabilities.resolveUnsubscribeCapability(single))
      .resolves.toEqual({
        scope: 'SUBSCRIPTION',
        contactId: 'contact-1',
        subscriptionId: 'subscription-1',
        lifecycleGeneration: 1
      })
    await expect(capabilities.resolveUnsubscribeCapability(all))
      .resolves.toEqual({ scope: 'ALL', contactId: 'contact-1', capabilityGeneration: 1 })

    for (const [index, value] of [
      [1, 'a'], [2, btoa('contact-2')], [3, btoa('subscription-2')], [4, '2']
    ] as const) {
      const parts = single.split('.')
      parts[index] = value.replaceAll('=', '')
      await expect(capabilities.resolveUnsubscribeCapability(parts.join('.')))
        .resolves.toBeNull()
    }

    const replacement = await capabilities.issueUnsubscribeCapability({
      contactId: 'contact-1',
      subscriptionId: 'subscription-1',
      lifecycleGeneration: 2
    })
    expect(replacement).not.toBe(single)
  })

  it('scopes confirmation replacement and revocation to the supplied lifecycle generation', async () => {
    const { capabilities, confirmationStore } = secureCapabilities()
    for (const [token, lifecycleGeneration] of [
      ['old', 1], ['current', 2], ['delayed-old', 1]
    ] as const) {
      await capabilities.replaceConfirmation({
        token,
        contactId: 'contact-1',
        subscriptionId: 'subscription-1',
        lifecycleGeneration,
        issuedAt: now,
        expiresAt: new Date(now.getTime() + 60_000),
        replacementStrategy: CONFIRMATION_REPLACEMENT_STRATEGIES.REPLACE_PREVIOUS,
        maxActiveTokens: 1
      }, confirmationStore)
    }
    await capabilities.revokeConfirmations('subscription-1', 1, now, confirmationStore)
    await expect(capabilities.resolveConfirmation('old', now, confirmationStore)).resolves.toBeNull()
    await expect(capabilities.resolveConfirmation('delayed-old', now, confirmationStore)).resolves.toBeNull()
    await expect(capabilities.resolveConfirmation('current', now, confirmationStore))
      .resolves.toMatchObject({ subscriptionId: 'subscription-1', lifecycleGeneration: 2 })
  })

  it.each([
    ['a short string secret', 'too-short'],
    ['a missing environment secret', undefined as unknown as string],
    ['a short byte secret', new Uint8Array(31)]
  ])('rejects %s synchronously instead of with an unhandled rejection', (_, value) => {
    expect(() => createSecureCapabilities({ hmacSecret: value }))
      .toThrow(expect.objectContaining({ code: NEWSLETTER_ERROR_CODES.INVALID_CONFIGURATION }))
    expect(() => createHmacRateLimitKeyProvider({ secret: value }))
      .toThrow(expect.objectContaining({ code: NEWSLETTER_ERROR_CODES.INVALID_CONFIGURATION }))
  })

  it('keeps confirmation and unsubscribe purposes separate', async () => {
    const { capabilities, confirmationStore } = secureCapabilities()

    const unsubscribe = await capabilities.issueUnsubscribeCapability({
      contactId: 'contact-1',
      subscriptionId: 'subscription-1',
      lifecycleGeneration: 1
    })
    await capabilities.replaceConfirmation({
      token: 'confirmation-token',
      contactId: 'contact-1',
      subscriptionId: 'subscription-1',
      lifecycleGeneration: 1,
      issuedAt: now,
      expiresAt: new Date(now.getTime() + 60_000),
      replacementStrategy: CONFIRMATION_REPLACEMENT_STRATEGIES.REPLACE_PREVIOUS,
      maxActiveTokens: 1
    }, confirmationStore)

    await expect(capabilities.consumeConfirmation(unsubscribe, now, confirmationStore))
      .resolves.toBeNull()
    await expect(capabilities.resolveUnsubscribeCapability('confirmation-token'))
      .resolves.toBeNull()
  })

  it('cleans terminal confirmation records only after retention', async () => {
    const { capabilities, confirmationStore } = secureCapabilities()

    await capabilities.replaceConfirmation({
      token: 'cleanup-token',
      contactId: 'contact-1',
      subscriptionId: 'subscription-1',
      lifecycleGeneration: 1,
      issuedAt: now,
      expiresAt: new Date(now.getTime() + 1_000),
      replacementStrategy: CONFIRMATION_REPLACEMENT_STRATEGIES.REPLACE_PREVIOUS,
      maxActiveTokens: 1
    }, confirmationStore)
    await capabilities.consumeConfirmation('cleanup-token', now, confirmationStore)

    await expect(capabilities.cleanupConfirmations({
      deleteBefore: new Date(now.getTime() - 1)
    }, confirmationStore)).resolves.toBe(0)
    await expect(capabilities.cleanupConfirmations({
      deleteBefore: new Date(now.getTime() + 1)
    }, confirmationStore)).resolves.toBe(1)
    expect(confirmationStore.snapshot()).toHaveLength(0)
  })
})

describe('abuse protection', () => {
  it('creates deterministic privacy-preserving rate-limit keys', async () => {
    const provider = createHmacRateLimitKeyProvider({ secret })
    const input = {
      action: 'subscribe' as const,
      email: 'person@example.com',
      audienceKey: 'default'
    }

    const first = await provider.createKey(input)
    const second = await provider.createKey(input)

    expect(first).toBe(second)
    expect(first).toMatch(/^[0-9a-f]{64}$/u)
    expect(first).not.toContain(input.email)
  })

  it('keeps rate-limit action buckets independent', async () => {
    const limiter = memoryRateLimiter({ now: () => now })

    await expect(limiter.consume({
      key: 'private-key',
      action: 'subscribe',
      limit: 1,
      windowMs: 60_000
    })).resolves.toEqual({ allowed: true })

    await expect(limiter.consume({
      key: 'private-key',
      action: 'subscribe',
      limit: 1,
      windowMs: 60_000
    })).resolves.toMatchObject({ allowed: false })

    await expect(limiter.consume({
      key: 'private-key',
      action: 'resend-confirmation',
      limit: 1,
      windowMs: 60_000
    })).resolves.toEqual({ allowed: true })
  })

  it('runs the abuse guard before persistence and mail delivery', async () => {
    const storage = memoryStorage()
    const { capabilities } = secureCapabilities()
    const mailer = { sendConfirmation: vi.fn(async () => ({ accepted: true })) }
    const guard = {
      verify: vi.fn(async () => ({ allowed: false }))
    }
    const newsletter = createNewsletter({
      storage,
      capabilities,
      mailer,
      abuseGuard: guard
    })

    await expect(newsletter.subscribe({
      email: 'blocked@example.com',
      consent: { granted: true, version: 'v1' },
      securityContext: { proof: 'invalid' }
    })).rejects.toMatchObject({
      code: NEWSLETTER_ERROR_CODES.ABUSE_REJECTED
    })

    expect(guard.verify).toHaveBeenCalledOnce()
    expect(mailer.sendConfirmation).not.toHaveBeenCalled()
    expect(await newsletter.getContact({ email: 'blocked@example.com' }))
      .toBeNull()
  })

  it('rate-limits signup without leaking a raw e-mail key', async () => {
    const storage = memoryStorage()
    const { capabilities } = secureCapabilities()
    const limiter = memoryRateLimiter({ now: () => now })
    const newsletter = createNewsletter({
      storage,
      capabilities,
      mailer: { async sendConfirmation() { return { accepted: true } } },
      rateLimiter: limiter,
      rateLimitKeyProvider: createHmacRateLimitKeyProvider({ secret }),
      rateLimits: {
        subscribe: { limit: 1, windowMs: 60_000 }
      }
    })

    await expect(newsletter.subscribe({
      email: 'person@example.com',
      consent: { granted: true, version: 'v1' }
    })).resolves.toEqual({ accepted: true })

    await expect(newsletter.subscribe({
      email: 'person@example.com',
      consent: { granted: true, version: 'v1' }
    })).rejects.toMatchObject({
      code: NEWSLETTER_ERROR_CODES.RATE_LIMITED
    })

    expect(limiter.snapshotKeys().join(' '))
      .not.toContain('person@example.com')
  })

  it('exposes the limiter retry delay on rate-limit errors', async () => {
    const newsletter = createNewsletter({
      storage: memoryStorage(),
      capabilities: secureCapabilities().capabilities,
      mailer: { async sendConfirmation() { return { accepted: true } } },
      rateLimiter: memoryRateLimiter({ now: () => now }),
      rateLimitKeyProvider: createHmacRateLimitKeyProvider({ secret }),
      rateLimits: { resendConfirmation: { limit: 1, windowMs: 60_000 } }
    })

    await newsletter.resendConfirmation({ email: 'person@example.com' })
    await expect(newsletter.resendConfirmation({ email: 'person@example.com' }))
      .rejects.toMatchObject({
        code: NEWSLETTER_ERROR_CODES.RATE_LIMITED,
        retryAfterMs: 60_000
      })
  })
})

describe('secure lifecycle integration', () => {
  it('does not burn a confirmation token when the state transaction fails', async () => {
    const messages: string[] = []
    const baseStorage = memoryStorage()
    let failNextTransaction = false
    const storage = {
      transaction: async <T>(
        operation: Parameters<typeof baseStorage.transaction<T>>[0]
      ): Promise<T> => {
        if (failNextTransaction) {
          failNextTransaction = false
          throw new Error('simulated storage failure')
        }
        return baseStorage.transaction(operation)
      }
    }
    const capabilities = createSecureCapabilities({ hmacSecret: secret })
    const newsletter = createNewsletter({
      storage,
      capabilities,
      mailer: {
        async sendConfirmation(input) {
          messages.push(input.token)
          return { accepted: true }
        }
      }
    })

    await newsletter.subscribe({
      email: 'retry@example.com',
      consent: { granted: true, version: 'v1' }
    })
    await vi.waitFor(() => expect(messages).toHaveLength(1))

    failNextTransaction = true
    await expect(newsletter.confirm({ token: messages[0]! }))
      .rejects.toThrow('simulated storage failure')
    await expect(newsletter.confirm({ token: messages[0]! }))
      .resolves.toEqual({ confirmed: true })
  })

  it('binds unsubscribe capabilities to one audience and invalidates old links after resubscribe', async () => {
    const messages: Array<{ token: string; audience: string }> = []
    const capabilities = createSecureCapabilities({ hmacSecret: secret })
    const newsletter = createNewsletter({
      storage: memoryStorage(),
      capabilities,
      mailer: {
        async sendConfirmation(input) {
          messages.push({
            token: input.token,
            audience: input.subscription.audienceKey
          })
          return { accepted: true }
        }
      },
      tokenGenerator: {
        generate: (() => {
          let value = 0
          return () => `confirmation-${++value}`
        })()
      }
    })

    await newsletter.subscribe({
      email: 'person@example.com',
      consent: { granted: true, version: 'v1' }
    })
    await newsletter.subscribe({
      email: 'person@example.com',
      audience: 'product-news',
      consent: { granted: true, version: 'v1' }
    })
    await vi.waitFor(() => expect(messages).toHaveLength(2))

    const defaultMessage = messages.find(
      message => message.audience === 'default'
    )!
    const oldProductToken = messages.find(
      message => message.audience === 'product-news'
    )!.token
    await newsletter.confirm({ token: defaultMessage.token })

    const productCapability = await newsletter.createUnsubscribeCapability({
      email: 'person@example.com',
      audience: 'product-news'
    })
    await expect(newsletter.unsubscribeAll({ capability: productCapability! }))
      .resolves.toEqual({ unsubscribed: false })
    await newsletter.unsubscribe({ capability: productCapability! })

    const subscriptions = await newsletter.listSubscriptions({
      email: 'person@example.com'
    })
    expect(subscriptions.find(item => item.audienceKey === 'default')?.status)
      .toBe(SUBSCRIPTION_STATUSES.ACTIVE)
    expect(subscriptions.find(item => item.audienceKey === 'product-news')?.status)
      .toBe(SUBSCRIPTION_STATUSES.UNSUBSCRIBED)

    const staleCapability = productCapability!
    await newsletter.subscribe({
      email: 'person@example.com',
      audience: 'product-news',
      consent: { granted: true, version: 'v2' }
    })
    await expect(newsletter.unsubscribe({ capability: staleCapability }))
      .resolves.toEqual({ unsubscribed: false })
    await expect(newsletter.confirm({ token: oldProductToken }))
      .resolves.toEqual({ confirmed: false })
  })
})
