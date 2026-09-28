import { describe, expect, it } from 'vitest'
import {
  createNewsletter,
  DEFAULT_AUDIENCE_KEY,
  DEFAULT_CONFIRMATION_EXPIRES_IN_MS,
  NEWSLETTER_ERROR_CODES,
  NewsletterError
} from '../src/index.js'
import { memoryCapabilities, memoryStorage } from '../src/memory.js'

const mailer = {
  async sendConfirmation() {
    return { accepted: true }
  }
}

const tokenGenerator = { generate: () => 'token' }

describe('createNewsletter', () => {
  it('constructs the core with provider-neutral test doubles', () => {
    const storage = memoryStorage()
    const capabilities = memoryCapabilities()

    const newsletter = createNewsletter({
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

  it('accepts injected deterministic dependencies', () => {
    const now = new Date('2026-09-28T08:00:00.000Z')
    const deterministicTokenGenerator = { generate: () => 'deterministic-token' }
    const idGenerator = { generate: () => 'deterministic-id' }

    const newsletter = createNewsletter({
      storage: memoryStorage(),
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
    expect(() => createNewsletter({
      storage: memoryStorage(),
      capabilities: memoryCapabilities(),
      mailer,
      tokenGenerator,
      confirmation: {
        expiresInMs: 0
      }
    })).toThrowError(NewsletterError)

    try {
      createNewsletter({
        storage: memoryStorage(),
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
})
