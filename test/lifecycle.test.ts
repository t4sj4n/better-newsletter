import { describe, expect, it } from 'vitest'
import {
  CONTACT_STATUSES,
  NEWSLETTER_ERROR_CODES,
  NEWSLETTER_EVENT_TYPES,
  SUBSCRIPTION_STATUSES,
  createNewsletter,
  type ConfirmationMailInput
} from '../src/index.js'
import {
  memoryCapabilities,
  memoryStorage
} from '../src/memory.js'

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

  const newsletter = createNewsletter({
    storage: memoryStorage(),
    capabilities: memoryCapabilities(),
    mailer: {
      async sendConfirmation(input) {
        messages.push(input)
        if (failMail) throw new Error('simulated provider failure')
        return {
          accepted: true,
          providerMessageId: `mail-${messages.length}`
        }
      }
    },
    clock: { now: () => new Date(nowMs) },
    idGenerator: { generate: () => `id-${++id}` },
    tokenGenerator: { generate: () => `token-${++token}` }
  })

  return {
    newsletter,
    messages,
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
    const { newsletter, messages } = setup()

    await expect(newsletter.subscribe({
      email: ' Person@Example.COM ',
      consent: consent()
    })).resolves.toEqual({ accepted: true })

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

  it('confirms exactly once and leaves repeated public signups neutral', async () => {
    const { newsletter, messages } = setup()

    const first = await newsletter.subscribe({
      email: 'person@example.com',
      consent: consent('v1')
    })
    const pendingRepeat = await newsletter.subscribe({
      email: 'person@example.com',
      consent: consent('v2')
    })

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
    const { newsletter, messages } = setup()

    await newsletter.subscribe({
      email: 'person@example.com',
      consent: consent('default-v1')
    })
    await newsletter.confirm({ token: messages[0]!.token })

    await newsletter.subscribe({
      email: 'person@example.com',
      audience: 'product-news',
      consent: consent('product-v1')
    })
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
    const { newsletter, messages, advance } = setup()

    await newsletter.subscribe({
      email: 'person@example.com',
      consent: consent('v1')
    })
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
    const { newsletter, messages } = setup()

    await newsletter.subscribe({ email: 'person@example.com', consent: consent() })
    await newsletter.confirm({ token: messages[0]!.token })
    await newsletter.subscribe({
      email: 'person@example.com',
      audience: 'product-news',
      consent: consent()
    })
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
    const { newsletter, messages } = setup()

    await newsletter.subscribe({ email: 'person@example.com', consent: consent() })
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
    expect(newsletter.getDeliveryEligibility(contact!, after!)).toEqual({
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
    const { newsletter } = setup()

    await newsletter.subscribe({ email: 'person@example.com', consent: consent() })
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
    const { newsletter, failNextMail } = setup()
    failNextMail()

    await newsletter.subscribe({
      email: 'person@example.com',
      consent: consent()
    })

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
    const { newsletter, messages } = setup()

    const results = await Promise.all([
      newsletter.subscribe({ email: 'person@example.com', consent: consent() }),
      newsletter.subscribe({ email: 'PERSON@example.com', consent: consent() })
    ])

    expect(results[0]).toEqual(results[1])
    expect(await newsletter.listSubscriptions({ email: 'person@example.com' }))
      .toHaveLength(1)
    expect(messages).toHaveLength(1)
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
