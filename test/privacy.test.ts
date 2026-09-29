import { describe, expect, it } from 'vitest'
import {
  CONTACT_STATUSES,
  NEWSLETTER_EVENT_TYPES,
  SUBSCRIPTION_STATUSES,
  betterNewsletter,
  createHmacSuppressionKeyProvider
} from '../packages/better-newsletter/src/index.js'
import { memoryAdapter, memoryCapabilities } from '../packages/better-newsletter/src/adapters/memory.js'

const now = new Date('2026-09-29T08:00:00.000Z')
const email = 'person@example.com'
const secret = 'private-token-digest'
const key = 'a'.repeat(64)

async function fixture() {
  const storage = memoryAdapter()
  const newsletter = betterNewsletter({
    storage,
    capabilities: memoryCapabilities(),
    mailer: { async sendConfirmation() { return { accepted: true } } },
    clock: { now: () => now },
    suppressionKeyProvider: () => key
  })
  await storage.transaction(async transaction => {
    await transaction.createContact({
      id: 'contact-1', capabilityGeneration: 1, email,
      status: CONTACT_STATUSES.SUPPRESSED,
      subject: { namespace: 'account', id: 'subject-1' },
      metadata: { privateNote: email },
      suppressedAt: now, suppressionReason: 'manual',
      createdAt: now, updatedAt: now
    })
    await transaction.createSubscription({
      id: 'subscription-1', lifecycleGeneration: 1, contactId: 'contact-1',
      audienceKey: 'news', status: SUBSCRIPTION_STATUSES.PENDING_CONFIRMATION,
      consent: { version: 'v1', source: email, locale: 'en', consentedAt: now },
      confirmationDelivery: null, createdAt: now, updatedAt: now
    })
    await transaction.confirmationTokens.replace({
      record: {
        digest: secret, purpose: 'CONFIRMATION', contactId: 'contact-1',
        subscriptionId: 'subscription-1', lifecycleGeneration: 1,
        createdAt: now, expiresAt: new Date(now.getTime() + 60_000)
      },
      strategy: 'REPLACE_PREVIOUS', maxActiveTokens: 1, now
    })
    await transaction.appendEvent({
      id: 'event-1', contactId: 'contact-1', subscriptionId: 'subscription-1',
      type: NEWSLETTER_EVENT_TYPES.SIGNED_UP, occurredAt: now,
      metadata: { copiedEmail: email }
    })
    await transaction.claimProviderEvent('provider', email, 'contact-1')
  })
  return { storage, newsletter }
}

describe('trusted contact privacy operations', () => {
  it('exports profile, consent, suppression, events and token metadata without digests', async () => {
    const { newsletter } = await fixture()
    const data = await newsletter.exportContactData({ email })
    expect(data?.contact).toMatchObject({
      email, subject: { namespace: 'account', id: 'subject-1' },
      status: CONTACT_STATUSES.SUPPRESSED, suppressionReason: 'manual'
    })
    expect(data?.subscriptions[0]?.consent).toMatchObject({ version: 'v1', source: email })
    expect(data?.events[0]?.metadata).toEqual({ copiedEmail: email })
    expect(data?.confirmationTokens).toMatchObject([{
      purpose: 'CONFIRMATION', subscriptionId: 'subscription-1',
      lifecycleGeneration: 1, expiresAt: new Date(now.getTime() + 60_000)
    }])
    expect(JSON.stringify(data)).not.toContain(secret)
  })

  it('deletes dependent data and optionally retains a suppression key', async () => {
    const { storage, newsletter } = await fixture()
    expect(await newsletter.eraseContactData({
      contact: { email }, strategy: 'DELETE', suppression: 'RETAIN_HASH'
    })).toEqual({ erased: true })
    expect(await newsletter.eraseContactData({
      contact: { email }, strategy: 'DELETE'
    })).toEqual({ erased: false })
    expect(await newsletter.exportContactData({ id: 'contact-1' })).toBeNull()
    expect(storage.confirmationTokenSnapshot()).toEqual([])
    await storage.transaction(async transaction => {
      expect(await transaction.listEvents('contact-1')).toEqual([])
      expect(await transaction.listSubscriptions('contact-1')).toEqual([])
      expect(await transaction.claimProviderEvent('provider', email, 'contact-1')).toBe(true)
      expect(await transaction.hasSuppressionKey(key)).toBe(true)
    })
    await newsletter.subscribe({ email, consent: { granted: true, version: 'v2' } })
    expect(await newsletter.getContact({ email })).toBeNull()
  })

  it('anonymizes identifiers and metadata while retaining minimized lifecycle events', async () => {
    const { storage, newsletter } = await fixture()
    const capability = await newsletter.createManagePreferencesCapability({ id: 'contact-1' })
    expect(capability).not.toBeNull()
    expect(await newsletter.eraseContactData({
      contact: { id: 'contact-1' }, strategy: 'ANONYMIZE'
    })).toEqual({ erased: true })
    const data = await newsletter.exportContactData({ id: 'contact-1' })
    expect(data?.contact.email).toMatch(/^erased-[0-9a-f-]+@erased\.invalid$/u)
    expect(data?.contact).toMatchObject({ subject: null, metadata: {}, status: 'SUPPRESSED' })
    expect(data?.subscriptions[0]).toMatchObject({
      status: 'UNSUBSCRIBED',
      consent: { version: '[erased]' }
    })
    expect(data?.subscriptions[0]?.audienceKey).toMatch(/^erased-[0-9a-f-]+$/u)
    expect(data?.subscriptions[0]?.consent.source).toBeUndefined()
    expect(data?.subscriptions[0]?.consent.locale).toBeUndefined()
    expect(data?.events).toMatchObject([{ type: 'SIGNED_UP', metadata: {} }])
    expect(data?.confirmationTokens).toEqual([])
    expect(storage.confirmationTokenSnapshot()).toEqual([])
    expect(JSON.stringify(data)).not.toContain(email)
    expect(JSON.stringify(data)).not.toContain(secret)
    expect(await newsletter.getContact({ email })).toBeNull()
    expect(await newsletter.listPreferences({ capability: capability! })).toBeNull()
    expect(await newsletter.eraseContactData({
      contact: { id: 'contact-1' }, strategy: 'ANONYMIZE'
    })).toEqual({ erased: false })
    expect(await newsletter.eraseContactData({
      contact: { id: 'contact-1' }, strategy: 'DELETE'
    })).toEqual({ erased: true })
    expect(await newsletter.exportContactData({ id: 'contact-1' })).toBeNull()
  })

  it('leaves no suppression key when the host chooses full erasure', async () => {
    const { storage, newsletter } = await fixture()
    await newsletter.eraseContactData({ contact: { email }, strategy: 'DELETE' })
    await storage.transaction(async transaction => {
      expect(await transaction.hasSuppressionKey(key)).toBe(false)
    })
    await newsletter.subscribe({ email, consent: { granted: true, version: 'v2' } })
    expect(await newsletter.getContact({ email })).not.toBeNull()
  })

  it('derives stable keyed suppression values without storing the address', async () => {
    const derive = createHmacSuppressionKeyProvider({
      secret: '0123456789abcdef0123456789abcdef'
    })
    const first = await derive(email)
    expect(first).toMatch(/^[a-f0-9]{64}$/u)
    expect(first).toBe(await derive(email))
    expect(first).not.toContain(email)
    expect(first).not.toBe(await derive('other@example.com'))
  })
})
