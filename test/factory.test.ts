import { describe, expect, it } from 'vitest'
import {
  betterNewsletter,
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
  it('exposes only lifecycle operations, not injected implementation details', () => {
    const storage = memoryAdapter()
    const capabilities = memoryCapabilities()

    const newsletter = betterNewsletter({
      storage,
      capabilities,
      mailer,
      tokenGenerator
    })

    expect(Object.keys(newsletter).sort()).toEqual([
      'cleanupConfirmationTokens',
      'confirm',
      'createConfirmationToken',
      'createManagePreferencesCapability',
      'createUnsubscribeCapability',
      'eraseContactData',
      'exportContactData',
      'getConfirmationState',
      'getContact',
      'getSubscription',
      'importSubscription',
      'linkSubject',
      'listEvents',
      'listPreferences',
      'listSubscriptionEvents',
      'listSubscriptions',
      'processFeedback',
      'removeRetainedSuppression',
      'resendConfirmation',
      'subscribe',
      'suppressContact',
      'unsubscribe',
      'unsubscribeAll',
      'unsuppressContact'
    ])
    expect(Object.isFrozen(newsletter)).toBe(true)
  })

  it('uses the secure Web Crypto token generator by default', async () => {
    const sent: string[] = []
    const tasks: Promise<void>[] = []
    const storage = memoryAdapter()
    const newsletter = betterNewsletter({
      storage,
      capabilities: memoryCapabilities(),
      mailer: {
        async sendConfirmation(input) {
          sent.push(input.token)
          return { accepted: true }
        }
      },
      runBackground(task) {
        tasks.push(task)
      }
    })

    await newsletter.subscribe({
      email: 'person@example.com',
      consent: { granted: true, version: 'v1' }
    })
    await Promise.all(tasks)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatch(/^[0-9a-f]{64}$/u)
    const [record] = storage.confirmationTokenSnapshot()
    expect(record!.expiresAt.getTime() - record!.createdAt.getTime())
      .toBe(DEFAULT_CONFIRMATION_EXPIRES_IN_MS)
  })

  it('honors injected deterministic dependencies through lifecycle behavior', async () => {
    const now = new Date('2026-09-28T08:00:00.000Z')
    const deterministicTokenGenerator = { generate: () => 'deterministic-token' }
    let id = 0
    const idGenerator = { generate: () => `deterministic-${++id}` }
    const storage = memoryAdapter()
    const sent: string[] = []
    const tasks: Promise<void>[] = []

    const newsletter = betterNewsletter({
      storage,
      capabilities: memoryCapabilities(),
      mailer: {
        async sendConfirmation(input) {
          sent.push(input.token)
          return { accepted: true }
        }
      },
      clock: { now: () => now },
      tokenGenerator: deterministicTokenGenerator,
      idGenerator,
      defaultAudience: 'product-news',
      confirmation: {
        expiresInMs: 60_000
      },
      runBackground(task) {
        tasks.push(task)
      }
    })

    await newsletter.subscribe({
      email: 'person@example.com',
      consent: { granted: true, version: 'v1' }
    })
    await Promise.all(tasks)

    const contact = await newsletter.getContact({ email: 'person@example.com' })
    const subscription = await newsletter.getSubscription({ email: 'person@example.com' })
    expect(contact?.id).toBe('deterministic-1')
    expect(contact?.createdAt).toEqual(now)
    expect(subscription?.id).toBe('deterministic-2')
    expect(subscription?.audienceKey).toBe('product-news')
    expect(sent).toEqual(['deterministic-token'])
    expect(storage.confirmationTokenSnapshot()[0]?.expiresAt)
      .toEqual(new Date(now.getTime() + 60_000))
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
