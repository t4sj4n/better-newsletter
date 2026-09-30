import { describe, expect, it } from 'vitest'
import {
  CONTACT_STATUSES,
  NEWSLETTER_EVENT_TYPES,
  SUBSCRIPTION_STATUSES,
  betterNewsletter
} from '../packages/better-newsletter/src/index.js'
import { memoryAdapter, memoryCapabilities } from '../packages/better-newsletter/src/adapters/memory.js'
import { createHmacSuppressionKeyProvider } from '../packages/better-newsletter/src/security.js'
import type { NewsletterStorage } from '../packages/better-newsletter/src/storage.js'
import { StorageConflictError } from '../packages/better-newsletter/src/errors.js'

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

  it('removes retained suppression without recreating a deleted contact', async () => {
    const { storage, newsletter } = await fixture()
    await newsletter.eraseContactData({ contact: { email }, strategy: 'DELETE', suppression: 'RETAIN_HASH' })
    await newsletter.subscribe({ email, consent: { granted: true, version: 'v2' } })
    expect(await newsletter.getContact({ email })).toBeNull()
    expect(await newsletter.removeRetainedSuppression({ email: ' Person@Example.COM ' })).toEqual({ removed: true })
    expect(await newsletter.removeRetainedSuppression({ email })).toEqual({ removed: false })
    await storage.transaction(async transaction => {
      expect(await transaction.hasSuppressionKey(key)).toBe(false)
    })
    expect(await newsletter.getContact({ email })).toBeNull()
    await newsletter.subscribe({ email, consent: { granted: true, version: 'v2' } })
    expect(await newsletter.getContact({ email })).not.toBeNull()
  })

  it('requires a provider for trusted removal', async () => {
    const newsletter = betterNewsletter({
      storage: memoryAdapter(), capabilities: memoryCapabilities(),
      mailer: { async sendConfirmation() { return { accepted: true } } }
    })
    await expect(newsletter.removeRetainedSuppression({ email })).rejects.toMatchObject({
      code: 'INVALID_CONFIGURATION'
    })
  })

  it('does not expose an address or digest from a failing host key provider', async () => {
    const newsletter = betterNewsletter({
      storage: memoryAdapter(), capabilities: memoryCapabilities(),
      mailer: { async sendConfirmation() { return { accepted: true } } },
      suppressionKeyProvider: () => { throw new Error(`${email} ${key}`) }
    })
    try {
      await newsletter.removeRetainedSuppression({ email })
      throw new Error('Expected key derivation to fail')
    } catch (error) {
      expect(error).toMatchObject({ code: 'INVALID_CONFIGURATION' })
      expect(String(error)).not.toContain(email)
      expect(String(error)).not.toContain(key)
    }
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

  it('keeps retained suppression effective across key rotation and removes every matching digest', async () => {
    const storage = memoryAdapter()
    const oldSecret = '0123456789abcdef0123456789abcdef'
    const newSecret = 'fedcba9876543210fedcba9876543210'
    const v1 = createHmacSuppressionKeyProvider({ secret: oldSecret })
    const rotated = createHmacSuppressionKeyProvider({ secrets: [
      { version: 2, value: newSecret }, { version: 1, value: oldSecret }
    ] })
    const service = (provider: typeof v1 | typeof rotated) => betterNewsletter({
      storage, capabilities: memoryCapabilities(), suppressionKeyProvider: provider,
      mailer: { async sendConfirmation() { return { accepted: true } } }
    })
    await service(v1).importSubscription({
      email, status: 'ACTIVE',
      consent: { version: 'v1', consentedAt: now }, confirmedAt: now
    })
    await service(v1).eraseContactData({ contact: { email }, strategy: 'DELETE', suppression: 'RETAIN_HASH' })
    const instanceA = service(rotated)
    const instanceB = service(rotated)
    await instanceA.subscribe({ email, consent: { granted: true, version: 'v2' } })
    expect(await instanceB.getContact({ email })).toBeNull()
    const [currentKey, oldKey] = await rotated(email)
    await storage.transaction(async transaction => {
      expect(await transaction.hasSuppressionKey(oldKey!)).toBe(true)
      expect(await transaction.hasSuppressionKey(currentKey!)).toBe(false)
      await transaction.retainSuppressionKey(currentKey!)
    })
    expect(await instanceB.removeRetainedSuppression({ email })).toEqual({ removed: true })
    await storage.transaction(async transaction => {
      expect(await transaction.hasSuppressionKey(oldKey!)).toBe(false)
      expect(await transaction.hasSuppressionKey(currentKey!)).toBe(false)
    })
    expect(await instanceA.removeRetainedSuppression({ email })).toEqual({ removed: false })
    await instanceA.subscribe({ email, consent: { granted: true, version: 'v2' } })
    expect(await instanceB.getContact({ email })).not.toBeNull()
    await instanceA.eraseContactData({ contact: { email }, strategy: 'DELETE', suppression: 'RETAIN_HASH' })
    await storage.transaction(async transaction => {
      expect(await transaction.hasSuppressionKey(currentKey!)).toBe(true)
      expect(await transaction.hasSuppressionKey(oldKey!)).toBe(false)
    })
    const result = await instanceB.removeRetainedSuppression({ email })
    expect(JSON.stringify(result)).not.toContain(oldSecret)
    expect(JSON.stringify(result)).not.toContain(newSecret)
    expect(JSON.stringify(result)).not.toContain(email)
  })

  it('makes a v1-only retained entry ineffective when v1 is deliberately retired', async () => {
    const storage = memoryAdapter()
    const v1 = createHmacSuppressionKeyProvider({ secret: '0123456789abcdef0123456789abcdef' })
    const v2 = createHmacSuppressionKeyProvider({ secrets: [
      { version: 2, value: 'fedcba9876543210fedcba9876543210' }
    ] })
    const service = (provider: typeof v1 | typeof v2) => betterNewsletter({
      storage, capabilities: memoryCapabilities(), suppressionKeyProvider: provider,
      mailer: { async sendConfirmation() { return { accepted: true } } }
    })
    const oldKey = await v1(email)
    await storage.transaction(transaction => transaction.retainSuppressionKey(oldKey))
    await service(v1).subscribe({ email, consent: { granted: true, version: 'v1' } })
    expect(await service(v1).getContact({ email })).toBeNull()
    await service(v2).subscribe({ email, consent: { granted: true, version: 'v1' } })
    expect(await service(v2).getContact({ email })).not.toBeNull()
  })

  it('rejects invalid suppression key rings without exposing their secrets', () => {
    const secret = '0123456789abcdef0123456789abcdef'
    for (const secrets of [
      [],
      [{ version: 1, value: secret }, { version: 1, value: secret }],
      [{ version: -1, value: secret }],
      [{ version: 1, value: 'short' }]
    ]) {
      try {
        createHmacSuppressionKeyProvider({ secrets })
        throw new Error('Expected invalid configuration')
      } catch (error) {
        expect(error).toMatchObject({ code: 'INVALID_CONFIGURATION' })
        expect(String(error)).not.toContain(secret)
      }
    }
  })

  it('derives an ID-based erasure key outside the mutation transaction and retries an email change', async () => {
    const backing = memoryAdapter()
    let active = false
    const storage: NewsletterStorage = {
      transaction: operation => backing.transaction(async transaction => {
        active = true
        try { return await operation(transaction) } finally { active = false }
      })
    }
    await storage.transaction(transaction => transaction.createContact({
      id: 'changing-contact', capabilityGeneration: 1, email,
      status: 'ENABLED', subject: null, createdAt: now, updatedAt: now
    }))
    const changedEmail = 'new@example.com'
    let calls = 0
    const newsletter = betterNewsletter({
      storage, capabilities: memoryCapabilities(),
      mailer: { async sendConfirmation() { return { accepted: true } } },
      suppressionKeyProvider: async address => {
        expect(active).toBe(false)
        calls += 1
        if (calls === 1) {
          await storage.transaction(transaction => transaction.updateContact('changing-contact', { email: changedEmail }))
        }
        return address === email ? 'a'.repeat(64) : 'b'.repeat(64)
      }
    })
    expect(await newsletter.eraseContactData({
      contact: { id: 'changing-contact' }, strategy: 'DELETE', suppression: 'RETAIN_HASH'
    })).toEqual({ erased: true })
    expect(calls).toBe(2)
    await storage.transaction(async transaction => {
      expect(await transaction.hasSuppressionKey('a'.repeat(64))).toBe(false)
      expect(await transaction.hasSuppressionKey('b'.repeat(64))).toBe(true)
    })
  })

  it('reuses a derived key across transaction conflicts', async () => {
    const backing = memoryAdapter()
    let fail = true
    const storage: NewsletterStorage = {
      transaction: operation => backing.transaction(async transaction => {
        if (fail) { fail = false; throw new StorageConflictError('retry') }
        return operation(transaction)
      })
    }
    await backing.transaction(transaction => transaction.createContact({
      id: 'retry-contact', capabilityGeneration: 1, email,
      status: 'ENABLED', subject: null, createdAt: now, updatedAt: now
    }))
    let calls = 0
    const newsletter = betterNewsletter({
      storage, capabilities: memoryCapabilities(),
      mailer: { async sendConfirmation() { return { accepted: true } } },
      suppressionKeyProvider: async () => { calls += 1; return key }
    })
    expect(await newsletter.eraseContactData({
      contact: { email }, strategy: 'DELETE', suppression: 'RETAIN_HASH'
    })).toEqual({ erased: true })
    expect(calls).toBe(1)
  })
})
