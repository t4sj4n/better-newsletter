import { describe, expect, it, vi } from 'vitest'
import {
  CAPABILITY_PURPOSES,
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
  memoryCapabilityNonceStore,
  memoryConfirmationTokenStore,
  memoryRateLimiter,
  memoryStorage
} from '../src/memory.js'

const secret = '0123456789abcdef0123456789abcdef'
const now = new Date('2026-09-28T10:00:00.000Z')

function secureCapabilities() {
  const confirmationStore = memoryConfirmationTokenStore()
  const nonceStore = memoryCapabilityNonceStore()
  const capabilities = createSecureCapabilities({
    confirmationStore,
    nonceStore,
    hmacSecret: secret,
    nonceGenerator: {
      generate: (() => {
        let nonce = 0
        return () => `nonce-${++nonce}`
      })()
    }
  })

  return { capabilities, confirmationStore, nonceStore }
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
      issuedAt: now,
      expiresAt: new Date(now.getTime() + 60_000),
      replacementStrategy: CONFIRMATION_REPLACEMENT_STRATEGIES.REPLACE_PREVIOUS,
      maxActiveTokens: 1
    })

    const stored = confirmationStore.snapshot()
    expect(stored).toHaveLength(1)
    expect(stored[0]?.digest).toBe(await sha256Digest(rawToken))
    expect(JSON.stringify(stored)).not.toContain(rawToken)

    const results = await Promise.all([
      capabilities.consumeConfirmation(rawToken, now),
      capabilities.consumeConfirmation(rawToken, now)
    ])

    expect(results.filter(Boolean)).toHaveLength(1)
    expect(results.filter(result => result == null)).toHaveLength(1)
  })

  it('rejects expired confirmation tokens', async () => {
    const { capabilities } = secureCapabilities()

    await capabilities.replaceConfirmation({
      token: 'expired-token',
      contactId: 'contact-1',
      subscriptionId: 'subscription-1',
      issuedAt: now,
      expiresAt: new Date(now.getTime() + 1_000),
      replacementStrategy: CONFIRMATION_REPLACEMENT_STRATEGIES.REPLACE_PREVIOUS,
      maxActiveTokens: 1
    })

    await expect(capabilities.consumeConfirmation(
      'expired-token',
      new Date(now.getTime() + 1_001)
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
        issuedAt,
        expiresAt: new Date(now.getTime() + 60_000),
        replacementStrategy:
          CONFIRMATION_REPLACEMENT_STRATEGIES.RETAIN_PREVIOUS_UNTIL_EXPIRY,
        maxActiveTokens: 2
      })
    }

    const active = confirmationStore.snapshot().filter(record =>
      record.consumedAt == null && record.revokedAt == null
    )
    expect(active).toHaveLength(2)
    await expect(capabilities.consumeConfirmation('token-1', now))
      .resolves.toBeNull()
    await expect(capabilities.consumeConfirmation('token-2', now))
      .resolves.toMatchObject({ subscriptionId: 'subscription-1' })
  })

  it('issues purpose-bound HMAC unsubscribe capabilities and rotates nonces', async () => {
    const { capabilities, nonceStore } = secureCapabilities()

    const single = await capabilities.issueUnsubscribeCapability!({
      contactId: 'contact-1',
      subscriptionId: 'subscription-1'
    })
    const all = await capabilities.issueUnsubscribeAllCapability!({
      contactId: 'contact-1'
    })

    expect(single).not.toContain('contact-1')
    expect(single).not.toContain('subscription-1')
    expect(single).not.toBe(all)
    await expect(capabilities.resolveUnsubscribeCapability(single))
      .resolves.toEqual({
        scope: 'SUBSCRIPTION',
        contactId: 'contact-1',
        subscriptionId: 'subscription-1'
      })
    await expect(capabilities.resolveUnsubscribeCapability(all))
      .resolves.toEqual({ scope: 'ALL', contactId: 'contact-1' })

    const records = nonceStore.snapshot()
    expect(records.some(record =>
      record.purpose === CAPABILITY_PURPOSES.UNSUBSCRIBE
    )).toBe(true)
    expect(records.some(record =>
      record.purpose === CAPABILITY_PURPOSES.UNSUBSCRIBE_ALL
    )).toBe(true)

    const tampered = `${single.slice(0, -1)}x`
    await expect(capabilities.resolveUnsubscribeCapability(tampered))
      .resolves.toBeNull()

    await capabilities.revokeUnsubscribeCapabilities('subscription-1')
    await expect(capabilities.resolveUnsubscribeCapability(single))
      .resolves.toBeNull()

    const replacement = await capabilities.issueUnsubscribeCapability!({
      contactId: 'contact-1',
      subscriptionId: 'subscription-1'
    })
    expect(replacement).not.toBe(single)
  })

  it('keeps confirmation and unsubscribe purposes separate', async () => {
    const { capabilities } = secureCapabilities()

    const unsubscribe = await capabilities.issueUnsubscribeCapability!({
      contactId: 'contact-1',
      subscriptionId: 'subscription-1'
    })
    await capabilities.replaceConfirmation({
      token: 'confirmation-token',
      contactId: 'contact-1',
      subscriptionId: 'subscription-1',
      issuedAt: now,
      expiresAt: new Date(now.getTime() + 60_000),
      replacementStrategy: CONFIRMATION_REPLACEMENT_STRATEGIES.REPLACE_PREVIOUS,
      maxActiveTokens: 1
    })

    await expect(capabilities.consumeConfirmation(unsubscribe, now))
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
      issuedAt: now,
      expiresAt: new Date(now.getTime() + 1_000),
      replacementStrategy: CONFIRMATION_REPLACEMENT_STRATEGIES.REPLACE_PREVIOUS,
      maxActiveTokens: 1
    })
    await capabilities.consumeConfirmation('cleanup-token', now)

    await expect(capabilities.cleanupConfirmations({
      deleteBefore: new Date(now.getTime() - 1)
    })).resolves.toBe(0)
    await expect(capabilities.cleanupConfirmations({
      deleteBefore: new Date(now.getTime() + 1)
    })).resolves.toBe(1)
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
})

describe('secure lifecycle integration', () => {
  it('binds unsubscribe capabilities to one audience and invalidates old links after resubscribe', async () => {
    const messages: Array<{ token: string; audience: string }> = []
    const confirmationStore = memoryConfirmationTokenStore()
    const capabilities = createSecureCapabilities({
      confirmationStore,
      nonceStore: memoryCapabilityNonceStore(),
      hmacSecret: secret,
      nonceGenerator: secureTokenGenerator
    })
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

    for (const message of messages) {
      await newsletter.confirm({ token: message.token })
    }

    const productCapability = await newsletter.createUnsubscribeCapability({
      email: 'person@example.com',
      audience: 'product-news'
    })
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
  })
})
