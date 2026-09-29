import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  betterNewsletter,
  CONTACT_STATUSES,
  DELIVERY_FEEDBACK_TYPES,
  NEWSLETTER_ERROR_CODES,
  NEWSLETTER_EVENT_TYPES,
  SUBSCRIPTION_STATUSES
} from '../packages/better-newsletter/src/index.js'
import { memoryAdapter, memoryCapabilities } from '../packages/better-newsletter/src/adapters/memory.js'
import type { NewsletterStorage } from '../packages/better-newsletter/src/storage.js'
import { resendWebhook } from '../packages/better-newsletter/src/webhooks/resend.js'

const email = 'person@example.com'
const occurredAt = new Date('2026-09-29T08:00:00.000Z')
const webhookSecret = `whsec_${Buffer.from('test webhook secret with enough entropy').toString('base64')}`

async function setup(softBounceThreshold?: number, storage: NewsletterStorage = memoryAdapter()) {
  const newsletter = betterNewsletter({
    storage,
    capabilities: memoryCapabilities(),
    mailer: { async sendConfirmation() { return { accepted: true as const } } },
    feedbackPolicy: softBounceThreshold === undefined ? {} : { softBounceThreshold }
  })
  for (const audience of ['default', 'product']) {
    await newsletter.importSubscription({
      email,
      audience,
      status: SUBSCRIPTION_STATUSES.ACTIVE,
      consent: { version: 'v1', consentedAt: occurredAt },
      confirmedAt: occurredAt
    })
  }
  return newsletter
}

function signedWebhook(type: string, id: string, extra: Record<string, unknown> = {}) {
  const timestamp = `${Math.floor(Date.now() / 1000)}`
  const payload = JSON.stringify({
    type,
    created_at: occurredAt.toISOString(),
    data: {
      email_id: 'email-1',
      to: [email],
      ...extra
    }
  })
  const signature = createHmac('sha256', Buffer.from(webhookSecret.slice(6), 'base64'))
    .update(`${id}.${timestamp}.${payload}`)
    .digest('base64')
  return {
    payload,
    headers: {
      'svix-id': id,
      'svix-timestamp': timestamp,
      'svix-signature': `v1,${signature}`
    }
  }
}

describe('delivery feedback', () => {
  it.each([
    ['HARD_BOUNCE', true],
    ['COMPLAINT', true],
    ['SOFT_BOUNCE', false],
    ['PROVIDER_SUPPRESSION', true],
    ['DELIVERED', false]
  ] as const)('processes %s while preserving consent', async (type, suppressed) => {
    const newsletter = await setup()
    const input = { provider: 'other', providerEventId: 'event-1', email, type: DELIVERY_FEEDBACK_TYPES[type], occurredAt }
    expect(await newsletter.processFeedback(input)).toEqual({ processed: true, suppressed })
    expect((await newsletter.getContact({ email }))?.status).toBe(
      suppressed ? CONTACT_STATUSES.SUPPRESSED : CONTACT_STATUSES.ENABLED
    )
    expect((await newsletter.listSubscriptions({ email })).map(s => s.status)).toEqual([
      SUBSCRIPTION_STATUSES.ACTIVE,
      SUBSCRIPTION_STATUSES.ACTIVE
    ])
    const events = await newsletter.listEvents({ email })
    expect(events.filter(e => e.type === NEWSLETTER_EVENT_TYPES.PROVIDER_FEEDBACK)).toHaveLength(1)
    expect(events.filter(e => e.type === NEWSLETTER_EVENT_TYPES.SUPPRESSED)).toHaveLength(suppressed ? 1 : 0)
    expect(await newsletter.processFeedback(input)).toEqual({ processed: false, suppressed })
    expect((await newsletter.listEvents({ email })).length).toBe(events.length)
  })

  it('applies the soft-bounce threshold to distinct events', async () => {
    const newsletter = await setup(2)
    const base = { provider: 'other', email, type: DELIVERY_FEEDBACK_TYPES.SOFT_BOUNCE, occurredAt }
    expect((await newsletter.processFeedback({ ...base, providerEventId: 'one' })).suppressed).toBe(false)
    expect((await newsletter.processFeedback({ ...base, providerEventId: 'one' })).processed).toBe(false)
    expect((await newsletter.processFeedback({ ...base, providerEventId: 'two' })).suppressed).toBe(true)
    expect((await newsletter.listEvents({ email })).filter(e => e.type === NEWSLETTER_EVENT_TYPES.SUPPRESSED)).toHaveLength(1)
  })

  it('counts only bounded soft bounces since unsuppression without loading audit history', async () => {
    const backing = memoryAdapter()
    const storage: NewsletterStorage = {
      transaction: operation => backing.transaction(transaction => operation({
        ...transaction,
        listEvents: async () => { throw new Error('Full audit history must not be read') }
      }))
    }
    const newsletter = await setup(2, storage)
    const input = { provider: 'other', email, occurredAt }
    await newsletter.processFeedback({ ...input, type: DELIVERY_FEEDBACK_TYPES.SOFT_BOUNCE, providerEventId: 'soft-1' })
    await newsletter.processFeedback({ ...input, type: DELIVERY_FEEDBACK_TYPES.DELIVERED, providerEventId: 'delivered' })
    expect((await newsletter.processFeedback({ ...input, type: DELIVERY_FEEDBACK_TYPES.SOFT_BOUNCE, providerEventId: 'soft-2' })).suppressed).toBe(true)
    await newsletter.unsuppressContact({ email })
    expect((await newsletter.processFeedback({ ...input, type: DELIVERY_FEEDBACK_TYPES.SOFT_BOUNCE, providerEventId: 'soft-3' })).suppressed).toBe(false)
    expect((await newsletter.processFeedback({ ...input, type: DELIVERY_FEEDBACK_TYPES.SOFT_BOUNCE, providerEventId: 'soft-3' })).processed).toBe(false)
    expect((await newsletter.processFeedback({ ...input, type: DELIVERY_FEEDBACK_TYPES.SOFT_BOUNCE, providerEventId: 'soft-4' })).suppressed).toBe(true)

    const contact = await newsletter.getContact({ email })
    const events = await backing.transaction(transaction => transaction.listEvents(contact!.id))
    expect(events.filter(event => event.type === NEWSLETTER_EVENT_TYPES.PROVIDER_FEEDBACK)).toHaveLength(5)
    expect(events.filter(event => event.metadata.feedbackType === DELIVERY_FEEDBACK_TYPES.DELIVERED)).toHaveLength(1)
    expect(await backing.transaction(transaction =>
      transaction.countSoftBouncesSinceUnsuppressed(contact!.id, 1)
    )).toBe(1)
  })

  it('does not add another suppression transition for an already-suppressed contact', async () => {
    const newsletter = await setup()
    await newsletter.suppressContact({ email, reason: 'manual' })
    await newsletter.processFeedback({ provider: 'other', providerEventId: 'complaint', email, type: DELIVERY_FEEDBACK_TYPES.COMPLAINT, occurredAt })
    expect((await newsletter.listEvents({ email })).filter(e => e.type === NEWSLETTER_EVENT_TYPES.SUPPRESSED)).toHaveLength(1)
  })

  it('does not unsuppress after delivery feedback', async () => {
    const newsletter = await setup()
    await newsletter.processFeedback({ provider: 'other', providerEventId: 'bounce', email, type: DELIVERY_FEEDBACK_TYPES.HARD_BOUNCE, occurredAt })
    await newsletter.processFeedback({ provider: 'other', providerEventId: 'delivered', email, type: DELIVERY_FEEDBACK_TYPES.DELIVERED, occurredAt })
    expect((await newsletter.getContact({ email }))?.status).toBe(CONTACT_STATUSES.SUPPRESSED)
  })

  it('verifies Resend signatures before processing and hides payload and secret in errors', async () => {
    const newsletter = await setup()
    const handle = resendWebhook({ newsletter, webhookSecret })
    const request = signedWebhook('email.bounced', 'msg-1', { bounce: { type: 'Permanent', subType: 'General', message: 'secret payload' } })
    await expect(handle({ ...request, headers: { ...request.headers, 'svix-signature': 'v1,invalid' } }))
      .rejects.toMatchObject({ code: NEWSLETTER_ERROR_CODES.INVALID_WEBHOOK, message: 'Invalid Resend webhook.' })
    expect((await newsletter.getContact({ email }))?.status).toBe(CONTACT_STATUSES.ENABLED)
    expect(await handle(request)).toEqual({ processed: true, suppressed: true })
    expect(await handle(request)).toEqual({ processed: false, suppressed: true })
    expect(JSON.stringify(await newsletter.listEvents({ email }))).not.toContain('secret payload')
    expect(JSON.stringify(await newsletter.listEvents({ email }))).not.toContain(webhookSecret)
  })

  it('maps transient bounces, complaints, and suppression events', async () => {
    for (const [type, extra, suppressed] of [
      ['email.bounced', { bounce: { type: 'Transient' } }, false],
      ['email.complained', {}, true],
      ['email.suppressed', {}, true],
      ['suppression.added', { email, origin: 'bounce' }, true]
    ] as const) {
      const newsletter = await setup()
      const handle = resendWebhook({ newsletter, webhookSecret })
      expect((await handle(signedWebhook(type, `msg-${type}`, extra))).suppressed).toBe(suppressed)
    }
  })
})
