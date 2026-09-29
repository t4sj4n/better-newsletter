import { describe, expect, it } from 'vitest'
import {
  betterNewsletter,
  DEFAULT_AUDIENCE_KEY,
  DEFAULT_CONFIRMATION_EXPIRES_IN_MS,
  NEWSLETTER_ERROR_CODES,
  NewsletterError
} from '../packages/better-newsletter/src/index.js'
import { memoryCapabilities, memoryAdapter } from '../packages/better-newsletter/src/adapters/memory.js'

const mailer = {
  async sendConfirmation() {
    return { accepted: true }
  }
}

const tokenGenerator = { generate: () => 'token' }

describe('betterNewsletter', () => {
  it('constructs the core with provider-neutral test doubles', () => {
    const storage = memoryAdapter()
    const capabilities = memoryCapabilities()

    const newsletter = betterNewsletter({
      storage,
      capabilities,
      mailer,
      tokenGenerator
    })

    expect(newsletter.storage).toBe(storage)
    expect(newsletter.mailer).toBe(mailer)
    expect(newsletter.capabilities).toBe(capabilities)
    expect(newsletter.defaultAudience).toBe(DEFAULT_AUDIENCE_KEY)
    expect(newsletter.confirmation.expiresInMs)
      .toBe(DEFAULT_CONFIRMATION_EXPIRES_IN_MS)
    expect(newsletter.clock.now()).toBeInstanceOf(Date)
  })

  it('uses the secure Web Crypto token generator by default', () => {
    const newsletter = betterNewsletter({
      storage: memoryAdapter(),
      capabilities: memoryCapabilities(),
      mailer
    })

    const token = newsletter.tokenGenerator.generate()
    expect(token).toMatch(/^[0-9a-f]{64}$/u)
  })

  it('accepts injected deterministic dependencies', () => {
    const now = new Date('2026-09-28T08:00:00.000Z')
    const deterministicTokenGenerator = { generate: () => 'deterministic-token' }
    const idGenerator = { generate: () => 'deterministic-id' }

    const newsletter = betterNewsletter({
      storage: memoryAdapter(),
      capabilities: memoryCapabilities(),
      mailer,
      clock: { now: () => now },
      tokenGenerator: deterministicTokenGenerator,
      idGenerator,
      defaultAudience: 'product-news',
      confirmation: {
        expiresInMs: 60_000
      }
    })

    expect(newsletter.clock.now()).toBe(now)
    expect(newsletter.tokenGenerator).toBe(deterministicTokenGenerator)
    expect(newsletter.idGenerator).toBe(idGenerator)
    expect(newsletter.defaultAudience).toBe('product-news')
    expect(newsletter.confirmation.expiresInMs).toBe(60_000)
  })

  it('rejects invalid confirmation configuration', () => {
    expect(() => betterNewsletter({
      storage: memoryAdapter(),
      capabilities: memoryCapabilities(),
      mailer,
      tokenGenerator,
      confirmation: {
        expiresInMs: 0
      }
    })).toThrowError(NewsletterError)

    try {
      betterNewsletter({
        storage: memoryAdapter(),
        capabilities: memoryCapabilities(),
        mailer,
        tokenGenerator,
        confirmation: {
          expiresInMs: 0
        }
      })
    } catch (error) {
      expect(error).toBeInstanceOf(NewsletterError)
      expect((error as NewsletterError).code)
        .toBe(NEWSLETTER_ERROR_CODES.INVALID_CONFIGURATION)
    }
  })

  it.each([0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects an invalid confirmation delivery lease: %s',
    deliveryLeaseMs => {
      expect(() => betterNewsletter({
        storage: memoryAdapter(),
        capabilities: memoryCapabilities(),
        mailer,
        confirmation: { deliveryLeaseMs }
      })).toThrow('confirmation.deliveryLeaseMs must be a positive safe integer.')
    }
  )

  it.each([0, -1, 1.5, Infinity])(
    'rejects invalid transactionMaxAttempts: %s',
    transactionMaxAttempts => {
      expect(() => betterNewsletter({
        storage: memoryAdapter(),
        capabilities: memoryCapabilities(),
        mailer,
        transactionMaxAttempts
      })).toThrow('transactionMaxAttempts must be a positive safe integer.')
    }
  )
})
