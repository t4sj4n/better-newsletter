import { describe, expect, it, vi } from 'vitest'
import {
  CONTACT_STATUSES,
  NEWSLETTER_ERROR_CODES,
  NEWSLETTER_EVENT_TYPES,
  SUBSCRIPTION_STATUSES,
  betterNewsletter,
  getDeliveryEligibility
} from '../packages/better-newsletter/src/index.js'
import type { ConfirmationMailInput, NewsletterMailer } from '../packages/better-newsletter/src/mailers/index.js'
import type { NewsletterStorage } from '../packages/better-newsletter/src/storage.js'
import {
  memoryCapabilities,
  memoryAdapter
} from '../packages/better-newsletter/src/adapters/memory.js'

/**
 * Creates an isolated lifecycle fixture with deterministic time, IDs, and tokens.
 * Returns captured mail and controls to advance time or enable mail failures.
 */
function setup() {
  let nowMs = Date.parse('2026-09-28T08:00:00.000Z')
  let id = 0
  let token = 0
  let failMail = false
  const messages: ConfirmationMailInput[] = []
  const capabilities = memoryCapabilities()
  const mailer: NewsletterMailer = {
    async sendConfirmation(input: ConfirmationMailInput) {
      messages.push(input)
      if (failMail) throw new Error('simulated provider failure')
      return {
        accepted: true,
        providerMessageId: `mail-${messages.length}`
      }
    }
  }

  const newsletter = betterNewsletter({
    storage: memoryAdapter(),
    capabilities,
    mailer,
    clock: { now: () => new Date(nowMs) },
    idGenerator: { generate: () => `id-${++id}` },
    tokenGenerator: { generate: () => `token-${++token}` }
  })

  return {
    newsletter,
    mailer,
    capabilities,
    messages,
    async waitForMail(count = 1) {
      await vi.waitFor(async () => {
        const events = await newsletter.listEvents({ email: 'person@example.com' })
        expect(events.filter(event =>
          event.type === NEWSLETTER_EVENT_TYPES.CONFIRMATION_SENT
          || event.type === NEWSLETTER_EVENT_TYPES.CONFIRMATION_SEND_FAILED
        )).toHaveLength(count)
      })
    },
    advance(ms = 1_000) {
      nowMs += ms
    },
    failNextMail() {
      failMail = true
    }
  }
}

const consent = (version = 'v1') => ({
  granted: true,
  version,
  source: 'landing-page'
} as const)

describe('newsletter lifecycle', () => {
  it('creates a normalized pending subscription and records delivery events', async () => {
    const { newsletter, messages, waitForMail } = setup()

    await expect(newsletter.subscribe({
      email: ' Person@Example.COM ',
      consent: consent()
    })).resolves.toEqual({ accepted: true })
    await waitForMail()

    const contact = await newsletter.getContact({ email: 'person@example.com' })
    const subscription = await newsletter.getSubscription({
      email: 'person@example.com'
    })
    const events = await newsletter.listEvents({ email: 'person@example.com' })

    expect(contact?.email).toBe('person@example.com')
    expect(subscription?.status).toBe(SUBSCRIPTION_STATUSES.PENDING_CONFIRMATION)
    expect(subscription?.consent.version).toBe('v1')
    expect(subscription?.confirmationSentAt).toBeInstanceOf(Date)
    expect(messages).toHaveLength(1)
    expect(events.map(event => event.type)).toEqual([
      NEWSLETTER_EVENT_TYPES.SIGNED_UP,
      NEWSLETTER_EVENT_TYPES.CONFIRMATION_REQUESTED,
      NEWSLETTER_EVENT_TYPES.CONFIRMATION_SENT
    ])
  })

  it('preserves subscribe context only in signup and resubscribe history', async () => {
    const { newsletter, messages, waitForMail } = setup()
    const initial = Object.freeze({ signupSource: 'pricing', context: Object.freeze({ campaign: 'launch' }) })
    const later = Object.freeze({ signupSource: 'coming-soon' })
    await newsletter.subscribe({ email: 'person@example.com', consent: consent(), metadata: initial })
    await waitForMail()
    const signup = (await newsletter.listEvents({ email: 'person@example.com' }))
      .find(event => event.type === NEWSLETTER_EVENT_TYPES.SIGNED_UP)!
    expect(signup.metadata).toEqual({ ...initial, audienceKey: 'default', consentVersion: 'v1', source: 'landing-page' })
    expect((await newsletter.getContact({ email: 'person@example.com' }))?.metadata).toBeUndefined()
    await newsletter.confirm({ token: messages[0]!.token })
    const capability = await newsletter.createUnsubscribeCapability({ email: 'person@example.com' })
    await newsletter.unsubscribe({ capability: capability! })
    await newsletter.subscribe({ email: 'person@example.com', consent: consent('v2'), metadata: later })
    await waitForMail(2)
    const events = await newsletter.listEvents({ email: 'person@example.com' })
    expect(events.find(event => event.type === NEWSLETTER_EVENT_TYPES.SIGNED_UP)).toEqual(signup)
    expect(events.find(event => event.type === NEWSLETTER_EVENT_TYPES.RESUBSCRIBED)?.metadata)
      .toEqual({ ...later, audienceKey: 'default', consentVersion: 'v2', source: 'landing-page' })
    expect((await newsletter.getContact({ email: 'person@example.com' }))?.metadata).toBeUndefined()
    expect(initial).toEqual({ signupSource: 'pricing', context: { campaign: 'launch' } })
    expect(later).toEqual({ signupSource: 'coming-soon' })
  })

  it('retains explicitly imported contact metadata when subscribing to another audience', async () => {
    const { newsletter, waitForMail } = setup()
    await newsletter.importSubscription({
      email: 'person@example.com', status: SUBSCRIPTION_STATUSES.ACTIVE,
      consent: { version: 'legacy', consentedAt: new Date('2025-01-01T00:00:00Z') },
      confirmedAt: new Date('2025-01-01T00:05:00Z'), metadata: { profile: 'imported' }
    })
    await newsletter.subscribe({
      email: 'person@example.com', audience: 'product', consent: consent(), metadata: { signupSource: 'pricing' }
    })
    await waitForMail()
    expect((await newsletter.getContact({ email: 'person@example.com' }))?.metadata).toEqual({ profile: 'imported' })
    expect((await newsletter.listEvents({ email: 'person@example.com' }))
      .find(event => event.type === NEWSLETTER_EVENT_TYPES.SIGNED_UP)?.metadata)
      .toEqual({ signupSource: 'pricing', audienceKey: 'product', consentVersion: 'v1', source: 'landing-page' })
  })

  it('keeps system metadata authoritative for signup and resubscribe collisions', async () => {
    const { newsletter, messages, waitForMail } = setup()
    const metadata = Object.freeze({ audienceKey: 'forged', consentVersion: 'forged', source: 'forged', custom: 'trusted-host-value' })
    await newsletter.subscribe({ email: 'person@example.com', audience: 'product', consent: consent(), metadata })
    await waitForMail()
    await newsletter.confirm({ token: messages[0]!.token })
    const capability = await newsletter.createUnsubscribeCapability({ email: 'person@example.com', audience: 'product' })
    await newsletter.unsubscribe({ capability: capability! })
    await newsletter.subscribe({ email: 'person@example.com', audience: 'product', consent: consent('v2'), metadata })
    await waitForMail(2)
    const events = (await newsletter.listEvents({ email: 'person@example.com' }))
      .filter(event => event.type === NEWSLETTER_EVENT_TYPES.SIGNED_UP || event.type === NEWSLETTER_EVENT_TYPES.RESUBSCRIBED)
    expect(events.map(event => event.metadata)).toEqual([
      { audienceKey: 'product', consentVersion: 'v1', source: 'landing-page', custom: 'trusted-host-value' },
      { audienceKey: 'product', consentVersion: 'v2', source: 'landing-page', custom: 'trusted-host-value' }
    ])
    expect(metadata.source).toBe('forged')
  })

  it('keeps signup and resubscribe event metadata unchanged when none is supplied', async () => {
    const { newsletter, messages, waitForMail } = setup()
    const input = { email: 'person@example.com', consent: { granted: true, version: 'v1' } }
    await newsletter.subscribe(input)
    await waitForMail()
    await newsletter.confirm({ token: messages[0]!.token })
    const capability = await newsletter.createUnsubscribeCapability({ email: input.email })
    await newsletter.unsubscribe({ capability: capability! })
    await newsletter.subscribe(input)
    await waitForMail(2)
    const events = (await newsletter.listEvents({ email: input.email }))
      .filter(event => event.type === NEWSLETTER_EVENT_TYPES.SIGNED_UP || event.type === NEWSLETTER_EVENT_TYPES.RESUBSCRIBED)
    expect(events.map(event => event.metadata)).toEqual([
      { audienceKey: 'default', consentVersion: 'v1' },
      { audienceKey: 'default', consentVersion: 'v1' }
    ])
  })

  it('confirms exactly once and leaves repeated public signups neutral', async () => {
    const { newsletter, messages, waitForMail } = setup()

    const first = await newsletter.subscribe({
      email: 'person@example.com',
      consent: consent('v1')
    })
    const pendingRepeat = await newsletter.subscribe({
      email: 'person@example.com',
      consent: consent('v2')
    })

    await waitForMail()
    expect(first).toEqual({ accepted: true })
    expect(pendingRepeat).toEqual(first)
    expect(messages).toHaveLength(1)

    const token = messages[0]!.token
    await expect(newsletter.confirm({ token })).resolves.toEqual({ confirmed: true })
    await expect(newsletter.confirm({ token })).resolves.toEqual({ confirmed: false })

    const activeRepeat = await newsletter.subscribe({
      email: 'person@example.com',
      consent: consent('v3')
    })
    const subscription = await newsletter.getSubscription({
      email: 'person@example.com'
    })

    expect(activeRepeat).toEqual(first)
    expect(messages).toHaveLength(1)
    expect(subscription?.status).toBe(SUBSCRIPTION_STATUSES.ACTIVE)
    expect(subscription?.consent.version).toBe('v1')
  })

  it('keeps multiple audiences independent', async () => {
    const { newsletter, messages, waitForMail } = setup()

    await newsletter.subscribe({
      email: 'person@example.com',
      consent: consent('default-v1')
    })
    await waitForMail()
    await newsletter.confirm({ token: messages[0]!.token })

    await newsletter.subscribe({
      email: 'person@example.com',
      audience: 'product-news',
      consent: consent('product-v1')
    })
    await waitForMail(2)
    await newsletter.confirm({ token: messages[1]!.token })

    const productCapability = await newsletter.createUnsubscribeCapability({
      email: 'person@example.com',
      audience: 'product-news'
    })
    expect(productCapability).not.toBeNull()
    await newsletter.unsubscribe({ capability: productCapability! })

    const subscriptions = await newsletter.listSubscriptions({
      email: 'person@example.com'
    })
    expect(subscriptions).toHaveLength(2)
    expect(subscriptions.find(item => item.audienceKey === 'default')?.status)
      .toBe(SUBSCRIPTION_STATUSES.ACTIVE)
    expect(subscriptions.find(item => item.audienceKey === 'product-news')?.status)
      .toBe(SUBSCRIPTION_STATUSES.UNSUBSCRIBED)
  })

  it('requires fresh consent and DOI after unsubscribe', async () => {
    const { newsletter, messages, advance, waitForMail } = setup()

    await newsletter.subscribe({
      email: 'person@example.com',
      consent: consent('v1')
    })
    await waitForMail()
    await newsletter.confirm({ token: messages[0]!.token })
    const oldCapability = await newsletter.createUnsubscribeCapability({
      email: 'person@example.com'
    })
    await newsletter.unsubscribe({ capability: oldCapability! })

    advance()
    await newsletter.subscribe({
      email: 'person@example.com',
      consent: consent('v2')
    })
    await waitForMail(2)

    const subscription = await newsletter.getSubscription({
      email: 'person@example.com'
    })
    const events = await newsletter.listEvents({ email: 'person@example.com' })

    expect(subscription?.status).toBe(SUBSCRIPTION_STATUSES.PENDING_CONFIRMATION)
    expect(subscription?.consent.version).toBe('v2')
    expect(subscription?.confirmedAt).toBeNull()
    expect(subscription?.unsubscribedAt).toBeNull()
    await expect(newsletter.unsubscribe({ capability: oldCapability! }))
      .resolves.toEqual({ unsubscribed: false })
    expect(events.some(event => event.type === NEWSLETTER_EVENT_TYPES.RESUBSCRIBED))
      .toBe(true)
  })

  it('unsubscribes all audiences without changing global suppression state', async () => {
    const { newsletter, messages, waitForMail } = setup()

    await newsletter.subscribe({ email: 'person@example.com', consent: consent() })
    await waitForMail()
    await newsletter.confirm({ token: messages[0]!.token })
    await newsletter.subscribe({
      email: 'person@example.com',
      audience: 'product-news',
      consent: consent()
    })
    await waitForMail(2)
    await newsletter.confirm({ token: messages[1]!.token })

    const allCapability = await newsletter.createUnsubscribeCapability({
      email: 'person@example.com',
      all: true
    })
    await newsletter.unsubscribeAll({ capability: allCapability! })

    const contact = await newsletter.getContact({ email: 'person@example.com' })
    const subscriptions = await newsletter.listSubscriptions({ email: 'person@example.com' })
    expect(contact?.status).toBe(CONTACT_STATUSES.ENABLED)
    expect(subscriptions.every(item =>
      item.status === SUBSCRIPTION_STATUSES.UNSUBSCRIBED
    )).toBe(true)

    await expect(newsletter.unsubscribeAll({ capability: allCapability! }))
      .resolves.toEqual({ unsubscribed: true })
  })

  it('suppresses delivery globally without rewriting subscription consent', async () => {
    const { newsletter, messages, waitForMail } = setup()

    await newsletter.subscribe({ email: 'person@example.com', consent: consent() })
    await waitForMail()
    await newsletter.confirm({ token: messages[0]!.token })
    const before = await newsletter.getSubscription({ email: 'person@example.com' })

    await newsletter.suppressContact({
      email: 'person@example.com',
      reason: 'BOUNCE'
    })

    const contact = await newsletter.getContact({ email: 'person@example.com' })
    const after = await newsletter.getSubscription({ email: 'person@example.com' })
    expect(contact?.status).toBe(CONTACT_STATUSES.SUPPRESSED)
    expect(after?.status).toBe(before?.status)
    expect(getDeliveryEligibility(contact!, after!)).toEqual({
      eligible: false,
      reason: 'CONTACT_SUPPRESSED'
    })

    await newsletter.subscribe({
      email: 'person@example.com',
      audience: 'another-list',
      consent: consent()
    })
    expect(messages).toHaveLength(1)
  })

  it('links subjects independently from consent and rejects implicit reassignment', async () => {
    const { newsletter, waitForMail } = setup()

    await newsletter.subscribe({ email: 'person@example.com', consent: consent() })
    await waitForMail()
    const before = await newsletter.getSubscription({ email: 'person@example.com' })

    await newsletter.linkSubject({
      email: 'person@example.com',
      subject: { namespace: 'app-user', id: 'user-1' }
    })
    const after = await newsletter.getSubscription({ email: 'person@example.com' })

    expect(after).toEqual(before)
    await expect(newsletter.linkSubject({
      email: 'person@example.com',
      subject: { namespace: 'app-user', id: 'user-2' }
    })).rejects.toMatchObject({ code: NEWSLETTER_ERROR_CODES.SUBJECT_CONFLICT })
  })

  it('imports known historical consent idempotently without sending mail', async () => {
    const { newsletter, messages } = setup()
    const consentedAt = new Date('2025-01-01T00:00:00.000Z')
    const confirmedAt = new Date('2025-01-01T00:05:00.000Z')
    const input = {
      email: 'legacy@example.com',
      status: SUBSCRIPTION_STATUSES.ACTIVE,
      consent: { version: 'legacy-v1', consentedAt },
      confirmedAt
    } as const

    const first = await newsletter.importSubscription(input)
    const second = await newsletter.importSubscription(input)
    const events = await newsletter.listEvents({ email: 'legacy@example.com' })

    expect(second).toEqual(first)
    expect(messages).toHaveLength(0)
    expect(events.map(event => event.type)).toEqual([
      NEWSLETTER_EVENT_TYPES.IMPORTED
    ])

    await expect(newsletter.importSubscription({
      email: 'invalid@example.com',
      status: SUBSCRIPTION_STATUSES.ACTIVE,
      consent: { version: 'legacy-v1', consentedAt }
    })).rejects.toMatchObject({ code: NEWSLETTER_ERROR_CODES.INVALID_IMPORT })
  })

  it('records provider failure without marking confirmation as sent', async () => {
    const { newsletter, failNextMail, waitForMail } = setup()
    failNextMail()

    await newsletter.subscribe({
      email: 'person@example.com',
      consent: consent()
    })

    await waitForMail()
    const subscription = await newsletter.getSubscription({
      email: 'person@example.com'
    })
    const events = await newsletter.listEvents({ email: 'person@example.com' })

    expect(subscription?.status).toBe(SUBSCRIPTION_STATUSES.PENDING_CONFIRMATION)
    expect(subscription?.confirmationSentAt).toBeNull()
    expect(events.at(-1)?.type)
      .toBe(NEWSLETTER_EVENT_TYPES.CONFIRMATION_SEND_FAILED)
  })

  it('serializes concurrent same-address signups in the memory adapter', async () => {
    const { newsletter, messages, waitForMail } = setup()

    const results = await Promise.all([
      newsletter.subscribe({ email: 'person@example.com', consent: consent() }),
      newsletter.subscribe({ email: 'PERSON@example.com', consent: consent() })
    ])

    await waitForMail()
    expect(results[0]).toEqual(results[1])
    expect(await newsletter.listSubscriptions({ email: 'person@example.com' }))
      .toHaveLength(1)
    expect(messages).toHaveLength(1)
  })

  it.each([
    {},
    { confirmedAt: null },
    { confirmedAt: new Date(), unsubscribedAt: new Date() }
  ])('rejects inconsistent active imports without persisting state: %j', async dates => {
    const { newsletter, messages } = setup()

    await expect(newsletter.importSubscription({
      email: 'invalid@example.com',
      status: SUBSCRIPTION_STATUSES.ACTIVE,
      consent: { version: 'legacy-v1', consentedAt: new Date() },
      ...dates
    })).rejects.toMatchObject({
      code: NEWSLETTER_ERROR_CODES.INVALID_IMPORT,
      message: 'Importing an active subscription requires confirmedAt and no unsubscribedAt.'
    })
    expect(await newsletter.getContact({ email: 'invalid@example.com' })).toBeNull()
    expect(await newsletter.listEvents({ email: 'invalid@example.com' })).toEqual([])
    expect(messages).toHaveLength(0)
  })

  it('accepts signup before a delayed mailer finishes', async () => {
    const { newsletter, waitForMail, mailer } = setup()
    let release!: () => void
    const delayed = new Promise<void>(resolve => { release = resolve })
    const send = vi.spyOn(mailer, 'sendConfirmation')
      .mockImplementation(async () => {
        await delayed
        return { accepted: true }
      })
    const accepted = vi.fn()
    const signup = newsletter.subscribe({
      email: 'person@example.com', consent: consent()
    }).then(accepted)

    try {
      await vi.waitFor(() => {
        expect(send).toHaveBeenCalledOnce()
        expect(accepted).toHaveBeenCalledWith({ accepted: true })
      })
      expect((await newsletter.getSubscription({ email: 'person@example.com' }))
        ?.confirmationSentAt).toBeNull()
    } finally {
      release()
      await signup
      await waitForMail()
    }
  })

  it('handles confirmation setup rejection after accepting signup', async () => {
    const { newsletter, messages, capabilities } = setup()
    const replace = vi.spyOn(capabilities, 'replaceConfirmation')
      .mockRejectedValue(new Error('capability store unavailable'))

    await expect(newsletter.subscribe({
      email: 'person@example.com', consent: consent()
    })).resolves.toEqual({ accepted: true })
    await vi.waitFor(() => expect(replace).toHaveBeenCalledOnce())
    expect(messages).toHaveLength(0)
    expect((await newsletter.getSubscription({ email: 'person@example.com' }))
      ?.status).toBe(SUBSCRIPTION_STATUSES.PENDING_CONFIRMATION)
  })

  it('revokes old unsubscribe-all links only on resubscription', async () => {
    const { newsletter, messages, waitForMail } = setup()
    await newsletter.subscribe({ email: 'person@example.com', consent: consent() })
    await waitForMail()
    const oldAll = await newsletter.createUnsubscribeCapability({
      email: 'person@example.com', all: true
    })
    const oldSingle = await newsletter.createUnsubscribeCapability({
      email: 'person@example.com'
    })
    await expect(newsletter.unsubscribeAll({ capability: oldAll! }))
      .resolves.toEqual({ unsubscribed: true })
    await expect(newsletter.unsubscribeAll({ capability: oldAll! }))
      .resolves.toEqual({ unsubscribed: true })

    await newsletter.subscribe({ email: 'person@example.com', consent: consent('v2') })
    await expect(newsletter.unsubscribeAll({ capability: oldAll! }))
      .resolves.toEqual({ unsubscribed: false })
    await expect(newsletter.unsubscribe({ capability: oldSingle! }))
      .resolves.toEqual({ unsubscribed: false })
    await waitForMail(2)
    await expect(newsletter.confirm({ token: messages[1]!.token }))
      .resolves.toEqual({ confirmed: true })
    await expect(newsletter.unsubscribeAll({ capability: oldAll! }))
      .resolves.toEqual({ unsubscribed: false })

    const freshAll = await newsletter.createUnsubscribeCapability({
      email: 'person@example.com', all: true
    })
    await expect(newsletter.unsubscribeAll({ capability: freshAll! }))
      .resolves.toEqual({ unsubscribed: true })
  })

  it('invalidates old unsubscribe-all links when an import adds an audience', async () => {
    const { newsletter } = setup()
    const history = {
      email: 'legacy@example.com',
      status: SUBSCRIPTION_STATUSES.ACTIVE,
      consent: { version: 'legacy-v1', consentedAt: new Date('2025-01-01T00:00:00.000Z') },
      confirmedAt: new Date('2025-01-01T00:05:00.000Z')
    } as const
    await newsletter.importSubscription({ ...history, audience: 'a' })
    const oldAll = (await newsletter.createUnsubscribeCapability({
      email: history.email, all: true
    }))!

    await newsletter.importSubscription({ ...history, audience: 'b' })
    await newsletter.importSubscription({ ...history, audience: 'b' })

    expect(await newsletter.getContact({ email: history.email }))
      .toMatchObject({ capabilityGeneration: 2 })
    await expect(newsletter.unsubscribeAll({ capability: oldAll }))
      .resolves.toEqual({ unsubscribed: false })
    expect((await newsletter.listSubscriptions({ email: history.email }))
      .map(subscription => subscription.status))
      .toEqual([SUBSCRIPTION_STATUSES.ACTIVE, SUBSCRIPTION_STATUSES.ACTIVE])
  })

  it('treats null and omitted consent fields as equal on repeated import', async () => {
    const storage = memoryAdapter()
    // SQL adapters read omitted optional columns back as null.
    const sqlLike: NewsletterStorage = {
      transaction: operation => storage.transaction(transaction => operation({
        ...transaction,
        async getSubscription(contactId, audienceKey) {
          const subscription = await transaction.getSubscription(contactId, audienceKey)
          return subscription == null
            ? null
            : { ...subscription, consent: { ...subscription.consent, source: null, locale: null } }
        }
      }))
    }
    const newsletter = betterNewsletter({
      storage: sqlLike,
      capabilities: memoryCapabilities(),
      mailer: { async sendConfirmation() { return { accepted: true } } }
    })
    const input = {
      email: 'legacy@example.com',
      status: SUBSCRIPTION_STATUSES.ACTIVE,
      consent: { version: 'legacy-v1', consentedAt: new Date('2025-01-01T00:00:00.000Z') },
      confirmedAt: new Date('2025-01-01T00:05:00.000Z')
    } as const

    await newsletter.importSubscription(input)
    await expect(newsletter.importSubscription(input)).resolves.toMatchObject({
      audienceKey: 'default',
      status: SUBSCRIPTION_STATUSES.ACTIVE
    })
    await expect(newsletter.importSubscription({
      ...input,
      consent: { ...input.consent, source: 'other' }
    })).rejects.toMatchObject({ code: NEWSLETTER_ERROR_CODES.IMPORT_CONFLICT })
  })

  it('hands background work to runBackground and reports failures through the logger', async () => {
    const storage = memoryAdapter()
    const tasks: Promise<void>[] = []
    const logger = { error: vi.fn() }
    const newsletter = betterNewsletter({
      storage: {
        transaction: operation => storage.transaction(transaction => operation({
          ...transaction,
          async appendEvent(event) {
            if (event.type === NEWSLETTER_EVENT_TYPES.CONFIRMATION_REQUESTED) {
              throw new Error('claim failed')
            }
            await transaction.appendEvent(event)
          }
        }))
      },
      capabilities: memoryCapabilities(),
      mailer: { async sendConfirmation() { return { accepted: true } } },
      runBackground: task => { tasks.push(task) },
      logger
    })

    await expect(newsletter.subscribe({ email: 'person@example.com', consent: consent() }))
      .resolves.toEqual({ accepted: true })
    await expect(newsletter.resendConfirmation({ email: 'person@example.com' }))
      .resolves.toEqual({ accepted: true })
    expect(tasks).toHaveLength(2)
    await expect(Promise.all(tasks)).resolves.toEqual([undefined, undefined])
    expect(logger.error).toHaveBeenCalledTimes(2)
    expect(logger.error.mock.calls[0]?.[1]).toMatchObject({ message: 'claim failed' })
  })

  it('requires explicit consent', async () => {
    const { newsletter } = setup()

    await expect(newsletter.subscribe({
      email: 'person@example.com',
      consent: { granted: false, version: 'v1' }
    })).rejects.toMatchObject({ code: NEWSLETTER_ERROR_CODES.CONSENT_REQUIRED })

    expect(await newsletter.getContact({ email: 'person@example.com' })).toBeNull()
  })
})
