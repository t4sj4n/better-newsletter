import { describe, expect, it } from 'vitest'
import {
  createNewsletter,
  DEFAULT_AUDIENCE_KEY,
  DEFAULT_CONFIRMATION_EXPIRES_IN_MS,
  NEWSLETTER_ERROR_CODES,
  NewsletterError
} from '../src/index.js'

describe('createNewsletter', () => {
  it('constructs the core with provider-neutral test doubles', () => {
    const storage = { name: 'test-storage' }
    const mailer = { name: 'test-mailer' }

    const newsletter = createNewsletter({
      storage,
      mailer
    })

    expect(newsletter.storage).toBe(storage)
    expect(newsletter.mailer).toBe(mailer)
    expect(newsletter.defaultAudience).toBe(DEFAULT_AUDIENCE_KEY)
    expect(newsletter.confirmation.expiresInMs)
      .toBe(DEFAULT_CONFIRMATION_EXPIRES_IN_MS)
    expect(newsletter.clock.now()).toBeInstanceOf(Date)
  })

  it('accepts injected deterministic dependencies', () => {
    const now = new Date('2026-09-28T08:00:00.000Z')
    const tokenGenerator = { generate: () => 'deterministic-token' }

    const newsletter = createNewsletter({
      storage: {},
      mailer: {},
      clock: { now: () => now },
      tokenGenerator,
      defaultAudience: 'product-news',
      confirmation: {
        expiresInMs: 60_000
      }
    })

    expect(newsletter.clock.now()).toBe(now)
    expect(newsletter.tokenGenerator).toBe(tokenGenerator)
    expect(newsletter.defaultAudience).toBe('product-news')
    expect(newsletter.confirmation.expiresInMs).toBe(60_000)
  })

  it('rejects invalid confirmation configuration', () => {
    expect(() => createNewsletter({
      storage: {},
      mailer: {},
      confirmation: {
        expiresInMs: 0
      }
    })).toThrowError(NewsletterError)

    try {
      createNewsletter({
        storage: {},
        mailer: {},
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
