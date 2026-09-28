import {
  CONFIRMATION_REPLACEMENT_STRATEGIES,
  CONTACT_STATUSES,
  NEWSLETTER_ERROR_CODES,
  NEWSLETTER_EVENT_TYPES,
  StorageConflictError,
  SUBSCRIPTION_STATUSES,
  createHmacRateLimitKeyProvider,
  createNewsletter,
  createSecureCapabilities,
  sha256Digest,
  type Clock,
  type ConfirmationMailInput,
  type NewsletterConfig,
  type NewsletterMailer,
  type NewsletterStorage,
  type PublicAbuseAction,
  type RateLimiter
} from '../src/index.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

export interface ConformanceRateLimiter extends RateLimiter {
  cleanup(input?: { readonly now?: Date }): Promise<number>
}

export interface StoredConfirmationTokenSnapshot {
  readonly digest: string
  readonly lifecycleGeneration: number
  readonly createdAt: Date
  readonly expiresAt: Date
  readonly consumedAt: Date | null
  readonly revokedAt: Date | null
}

export interface StoredRateLimitSnapshot {
  readonly key: string
  readonly action: string
  readonly windowMs: number
  readonly bucketStartMs: number
  readonly attemptCount: number
}

export interface StorageAdapterConformanceHarness {
  readonly name: string
  reset(): Promise<void>
  createStorage(): NewsletterStorage
  createRateLimiter(clock: Clock): ConformanceRateLimiter
  inspectConfirmationTokens(): Promise<readonly StoredConfirmationTokenSnapshot[]>
  inspectRateLimits(): Promise<readonly StoredRateLimitSnapshot[]>
}

const secret = '0123456789abcdef0123456789abcdef'
const email = 'person@example.com'
const baseTime = Date.parse('2026-09-28T08:00:00.000Z')
const consent = (version = 'v1') => ({
  granted: true,
  version,
  source: 'landing-page',
  locale: 'en'
} as const)

function gate() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}

function tokenRecord(
  digest: string,
  contactId: string,
  subscriptionId: string,
  lifecycleGeneration: number,
  createdAt: Date,
  expiresAt = new Date(createdAt.getTime() + 60_000)
) {
  return {
    digest,
    purpose: 'CONFIRMATION' as const,
    contactId,
    subscriptionId,
    lifecycleGeneration,
    createdAt,
    expiresAt,
    consumedAt: null,
    revokedAt: null
  }
}

async function seedPendingSubscription(storage: NewsletterStorage, now: Date) {
  return storage.transaction(async transaction => {
    const contact = await transaction.createContact({
      id: 'contact-1',
      capabilityGeneration: 1,
      email,
      status: CONTACT_STATUSES.ENABLED,
      subject: null,
      metadata: { tier: 'free' },
      createdAt: now,
      updatedAt: now
    })
    const subscription = await transaction.createSubscription({
      id: 'subscription-default',
      lifecycleGeneration: 1,
      contactId: contact.id,
      audienceKey: 'default',
      status: SUBSCRIPTION_STATUSES.PENDING_CONFIRMATION,
      consent: {
        version: 'v1',
        source: 'conformance',
        locale: 'en',
        consentedAt: now
      },
      confirmationDelivery: null,
      confirmationSentAt: null,
      confirmedAt: null,
      unsubscribedAt: null,
      createdAt: now,
      updatedAt: now
    })
    return { contact, subscription }
  })
}

export function registerStorageAdapterConformance(
  harness: StorageAdapterConformanceHarness
): void {
  describe(`${harness.name} storage conformance`, () => {
    const tasks = new Set<Promise<void>>()

    beforeEach(async () => {
      await harness.reset()
    })

    afterEach(async () => {
      while (tasks.size > 0) await Promise.all([...tasks])
      vi.restoreAllMocks()
    })

    function setup() {
      let nowMs = baseTime
      const clock = { now: () => new Date(nowMs) }
      const messages: ConfirmationMailInput[] = []
      let deliver: NewsletterMailer['sendConfirmation'] = async () => ({ accepted: true })
      const mailer: NewsletterMailer = {
        async sendConfirmation(input) {
          messages.push(input)
          return deliver(input)
        }
      }
      const makeService = (overrides: Partial<NewsletterConfig> = {}) =>
        createNewsletter({
          storage: harness.createStorage(),
          capabilities: createSecureCapabilities({ hmacSecret: secret }),
          mailer,
          clock,
          transactionMaxAttempts: 20,
          runBackground(task) {
            tasks.add(task)
            void task.then(() => tasks.delete(task))
          },
          ...overrides
        })

      return {
        service: makeService(),
        makeService,
        messages,
        clock,
        advance(milliseconds: number) {
          nowMs += milliseconds
        },
        setDelivery(next: NewsletterMailer['sendConfirmation']) {
          deliver = next
        },
        async settle() {
          while (tasks.size > 0) await Promise.all([...tasks])
        }
      }
    }

    it('round-trips Contact and Subscription state with deterministic subscription listing', async () => {
      const storage = harness.createStorage()
      const now = new Date(baseTime)
      const later = new Date(baseTime + 1_000)

      await storage.transaction(async transaction => {
        const contact = await transaction.createContact({
          id: 'contact-1',
          capabilityGeneration: 1,
          email,
          status: CONTACT_STATUSES.ENABLED,
          subject: null,
          metadata: { tier: 'free' },
          createdAt: now,
          updatedAt: now
        })
        await transaction.createSubscription({
          id: 'subscription-default',
          lifecycleGeneration: 1,
          contactId: contact.id,
          audienceKey: 'default',
          status: SUBSCRIPTION_STATUSES.PENDING_CONFIRMATION,
          consent: {
            version: 'v1',
            source: 'conformance',
            locale: 'en',
            consentedAt: now
          },
          confirmationDelivery: null,
          createdAt: now,
          updatedAt: now
        })
        await transaction.createSubscription({
          id: 'subscription-product',
          lifecycleGeneration: 1,
          contactId: contact.id,
          audienceKey: 'product',
          status: SUBSCRIPTION_STATUSES.PENDING_CONFIRMATION,
          consent: {
            version: 'v1',
            source: 'conformance',
            locale: 'en',
            consentedAt: now
          },
          confirmationDelivery: null,
          createdAt: later,
          updatedAt: later
        })

        await transaction.updateContact(contact.id, {
          capabilityGeneration: 2,
          subject: { namespace: 'app', id: 'member-1' },
          metadata: { tier: 'pro' },
          status: CONTACT_STATUSES.SUPPRESSED,
          suppressedAt: later,
          suppressionReason: 'TEST',
          updatedAt: later
        })
        await transaction.updateSubscription('subscription-default', {
          lifecycleGeneration: 2,
          status: SUBSCRIPTION_STATUSES.ACTIVE,
          confirmationDelivery: {
            id: 'delivery-1',
            attemptId: 'attempt-1',
            leaseExpiresAt: new Date(baseTime + 5_000)
          },
          confirmationSentAt: later,
          confirmedAt: later,
          updatedAt: later
        })
      })

      await storage.transaction(async transaction => {
        const contact = await transaction.getContactByEmail(email)
        expect(contact).toMatchObject({
          id: 'contact-1',
          capabilityGeneration: 2,
          email,
          status: CONTACT_STATUSES.SUPPRESSED,
          subject: { namespace: 'app', id: 'member-1' },
          metadata: { tier: 'pro' },
          suppressionReason: 'TEST'
        })
        expect(contact?.suppressedAt).toBeInstanceOf(Date)
        expect(Number.isSafeInteger(contact?.capabilityGeneration)).toBe(true)
        expect(await transaction.getContactById('contact-1')).toEqual(contact)

        const updated = await transaction.getSubscriptionById('subscription-default')
        expect(updated).toMatchObject({
          lifecycleGeneration: 2,
          status: SUBSCRIPTION_STATUSES.ACTIVE,
          confirmationDelivery: {
            id: 'delivery-1',
            attemptId: 'attempt-1'
          }
        })
        expect(updated?.confirmedAt).toBeInstanceOf(Date)
        expect(updated?.confirmationDelivery?.leaseExpiresAt).toBeInstanceOf(Date)
        expect(Number.isSafeInteger(updated?.lifecycleGeneration)).toBe(true)

        const first = await transaction.listSubscriptions('contact-1')
        const second = await transaction.listSubscriptions('contact-1')
        expect(second.map(subscription => subscription.id))
          .toEqual(first.map(subscription => subscription.id))
        expect(new Set(first.map(subscription => subscription.audienceKey)))
          .toEqual(new Set(['default', 'product']))
        expect(first.find(subscription => subscription.audienceKey === 'product')?.status)
          .toBe(SUBSCRIPTION_STATUSES.PENDING_CONFIRMATION)
      })
    })

    it('maps contact and per-audience uniqueness races to StorageConflictError', async () => {
      const storage = harness.createStorage()
      const now = new Date(baseTime)
      const { contact } = await seedPendingSubscription(storage, now)

      await expect(storage.transaction(transaction => transaction.createContact({
        id: 'contact-duplicate',
        capabilityGeneration: 1,
        email,
        status: CONTACT_STATUSES.ENABLED,
        subject: null,
        createdAt: now,
        updatedAt: now
      }))).rejects.toBeInstanceOf(StorageConflictError)

      await expect(storage.transaction(transaction => transaction.createSubscription({
        id: 'subscription-duplicate',
        lifecycleGeneration: 1,
        contactId: contact.id,
        audienceKey: 'default',
        status: SUBSCRIPTION_STATUSES.PENDING_CONFIRMATION,
        consent: { version: 'v1', consentedAt: now },
        confirmationDelivery: null,
        createdAt: now,
        updatedAt: now
      }))).rejects.toBeInstanceOf(StorageConflictError)
    })

    it('rolls back state, token mutations and events as one transaction', async () => {
      const storage = harness.createStorage()
      const now = new Date(baseTime)
      const later = new Date(baseTime + 1_000)
      const { contact, subscription } = await seedPendingSubscription(storage, now)
      const digest = await sha256Digest('rollback-token')

      await storage.transaction(async transaction => {
        await transaction.confirmationTokens.replace({
          record: tokenRecord(digest, contact.id, subscription.id, 1, now),
          strategy: CONFIRMATION_REPLACEMENT_STRATEGIES.RETAIN_PREVIOUS_UNTIL_EXPIRY,
          maxActiveTokens: 2,
          now
        })
        await transaction.appendEvent({
          id: 'event-before',
          contactId: contact.id,
          subscriptionId: subscription.id,
          type: NEWSLETTER_EVENT_TYPES.SIGNED_UP,
          occurredAt: now,
          metadata: { phase: 'before' }
        })
      })

      await expect(storage.transaction(async transaction => {
        await transaction.updateContact(contact.id, {
          capabilityGeneration: 2,
          status: CONTACT_STATUSES.SUPPRESSED,
          suppressedAt: later,
          suppressionReason: 'ROLLBACK',
          updatedAt: later
        })
        await transaction.updateSubscription(subscription.id, {
          lifecycleGeneration: 2,
          status: SUBSCRIPTION_STATUSES.ACTIVE,
          confirmedAt: later,
          updatedAt: later
        })
        expect(await transaction.confirmationTokens.consume({ digest, now: later }))
          .not.toBeNull()
        await transaction.appendEvent({
          id: 'event-rollback',
          contactId: contact.id,
          subscriptionId: subscription.id,
          type: NEWSLETTER_EVENT_TYPES.CONFIRMED,
          occurredAt: later,
          metadata: { phase: 'rollback' }
        })
        throw new Error('rollback conformance transaction')
      })).rejects.toThrow('rollback conformance transaction')

      await storage.transaction(async transaction => {
        expect(await transaction.getContactById(contact.id)).toMatchObject({
          capabilityGeneration: 1,
          status: CONTACT_STATUSES.ENABLED
        })
        expect(await transaction.getSubscriptionById(subscription.id)).toMatchObject({
          lifecycleGeneration: 1,
          status: SUBSCRIPTION_STATUSES.PENDING_CONFIRMATION,
          confirmedAt: null
        })
        expect(await transaction.confirmationTokens.resolve({ digest, now: later }))
          .toMatchObject({ digest, consumedAt: null, revokedAt: null })
        expect((await transaction.listEvents(contact.id)).map(event => event.id))
          .toEqual(['event-before'])
      })
    })

    it('keeps lifecycle events in append order and round-trips metadata', async () => {
      const storage = harness.createStorage()
      const now = new Date(baseTime)
      const { contact, subscription } = await seedPendingSubscription(storage, now)

      await storage.transaction(async transaction => {
        await transaction.appendEvent({
          id: 'event-1',
          contactId: contact.id,
          subscriptionId: subscription.id,
          type: NEWSLETTER_EVENT_TYPES.SIGNED_UP,
          occurredAt: now,
          metadata: { nested: { value: 1 }, list: ['a', 'b'] }
        })
        await transaction.appendEvent({
          id: 'event-2',
          contactId: contact.id,
          subscriptionId: subscription.id,
          type: NEWSLETTER_EVENT_TYPES.CONFIRMATION_REQUESTED,
          occurredAt: now,
          metadata: { audienceKey: 'default' }
        })
      })

      const events = await storage.transaction(transaction => transaction.listEvents(contact.id))
      expect(events.map(event => event.id)).toEqual(['event-1', 'event-2'])
      expect(events[0]?.metadata).toEqual({
        nested: { value: 1 },
        list: ['a', 'b']
      })
      expect(events[0]?.occurredAt).toBeInstanceOf(Date)
    })

    it.each([
      [CONFIRMATION_REPLACEMENT_STRATEGIES.REPLACE_PREVIOUS, ['digest-3']],
      [
        CONFIRMATION_REPLACEMENT_STRATEGIES.RETAIN_PREVIOUS_UNTIL_EXPIRY,
        ['digest-2', 'digest-3']
      ]
    ] as const)(
      'applies %s confirmation-token replacement with bounded retention',
      async (strategy, expectedActive) => {
        const storage = harness.createStorage()
        const now = new Date(baseTime)
        const { contact, subscription } = await seedPendingSubscription(storage, now)

        for (const digest of ['digest-1', 'digest-2', 'digest-3']) {
          await storage.transaction(transaction => transaction.confirmationTokens.replace({
            record: tokenRecord(digest, contact.id, subscription.id, 1, now),
            strategy,
            maxActiveTokens: 2,
            now
          }))
        }

        const active: string[] = []
        for (const digest of ['digest-1', 'digest-2', 'digest-3']) {
          const resolved = await storage.transaction(transaction =>
            transaction.confirmationTokens.resolve({ digest, now })
          )
          if (resolved != null) active.push(digest)
        }
        expect(active).toEqual(expectedActive)

        const snapshots = await harness.inspectConfirmationTokens()
        expect(snapshots).toHaveLength(3)
        expect(snapshots.filter(token => token.revokedAt == null))
          .toHaveLength(expectedActive.length)
      }
    )

    it('scopes tokens by lifecycle generation and supports expiry, single-use consume, revoke and cleanup', async () => {
      const storage = harness.createStorage()
      const now = new Date(baseTime)
      const { contact, subscription } = await seedPendingSubscription(storage, now)
      const digests = {
        consumed: 'digest-consumed',
        revoked: 'digest-revoked',
        expired: 'digest-expired',
        nextGeneration: 'digest-next-generation'
      }

      await storage.transaction(async transaction => {
        for (const [digest, generation, expiresAt] of [
          [digests.consumed, 1, new Date(baseTime + 60_000)],
          [digests.revoked, 1, new Date(baseTime + 60_000)],
          [digests.expired, 1, new Date(baseTime + 100)],
          [digests.nextGeneration, 2, new Date(baseTime + 60_000)]
        ] as const) {
          await transaction.confirmationTokens.replace({
            record: tokenRecord(
              digest,
              contact.id,
              subscription.id,
              generation,
              now,
              expiresAt
            ),
            strategy: CONFIRMATION_REPLACEMENT_STRATEGIES.RETAIN_PREVIOUS_UNTIL_EXPIRY,
            maxActiveTokens: 3,
            now
          })
        }
      })

      const consumeAt = new Date(baseTime + 1)
      await expect(storage.transaction(transaction =>
        transaction.confirmationTokens.consume({ digest: digests.consumed, now: consumeAt })
      )).resolves.toMatchObject({ digest: digests.consumed })
      await expect(storage.transaction(transaction =>
        transaction.confirmationTokens.consume({ digest: digests.consumed, now: consumeAt })
      )).resolves.toBeNull()

      await expect(storage.transaction(transaction =>
        transaction.confirmationTokens.revokeBySubscription({
          subscriptionId: subscription.id,
          lifecycleGeneration: 1,
          now: new Date(baseTime + 2)
        })
      )).resolves.toBe(2)

      await expect(storage.transaction(transaction =>
        transaction.confirmationTokens.resolve({
          digest: digests.nextGeneration,
          now: new Date(baseTime + 50_000)
        })
      )).resolves.toMatchObject({
        digest: digests.nextGeneration,
        lifecycleGeneration: 2
      })
      await expect(storage.transaction(transaction =>
        transaction.confirmationTokens.resolve({
          digest: digests.expired,
          now: new Date(baseTime + 101)
        })
      )).resolves.toBeNull()

      await expect(storage.transaction(transaction =>
        transaction.confirmationTokens.cleanup({
          deleteBefore: new Date(baseTime + 60_001)
        })
      )).resolves.toBe(4)
      expect(await harness.inspectConfirmationTokens()).toEqual([])
    })

    it('persists only confirmation digests and consumes one raw token exactly once across instances', async () => {
      const { service, makeService, messages, settle } = setup()
      await service.subscribe({ email, consent: consent() })
      await settle()
      const rawToken = messages[0]!.token
      const digest = await sha256Digest(rawToken)
      const snapshots = await harness.inspectConfirmationTokens()

      expect(snapshots.map(token => token.digest)).toEqual([digest])
      expect(JSON.stringify(snapshots)).not.toContain(rawToken)

      const other = makeService()
      const results = await Promise.all([
        service.confirm({ token: rawToken }),
        other.confirm({ token: rawToken })
      ])
      expect(results.filter(result => result.confirmed)).toHaveLength(1)
      expect(results.filter(result => !result.confirmed)).toHaveLength(1)
      expect((await service.getSubscription({ email }))?.status)
        .toBe(SUBSCRIPTION_STATUSES.ACTIVE)
    })

    it('persists subject, consent and suppression independently without leaking sensitive mail data into events', async () => {
      const { service, messages, settle } = setup()
      await service.subscribe({
        email: ' Person@Example.COM ',
        consent: consent(),
        subject: { namespace: 'crm', id: 'private-subject' },
        metadata: { tier: 'pro' }
      })
      await settle()

      expect(await service.getContact({ email })).toMatchObject({
        email,
        status: CONTACT_STATUSES.ENABLED,
        subject: { namespace: 'crm', id: 'private-subject' },
        metadata: { tier: 'pro' }
      })
      expect(await service.getSubscription({ email })).toMatchObject({
        audienceKey: 'default',
        status: SUBSCRIPTION_STATUSES.PENDING_CONFIRMATION,
        consent: { version: 'v1', source: 'landing-page', locale: 'en' }
      })

      await service.linkSubject({
        email,
        subject: { namespace: 'crm', id: 'other' },
        replace: true
      })
      await service.suppressContact({ email, reason: 'BOUNCE' })
      expect((await service.getSubscription({ email }))?.status)
        .toBe(SUBSCRIPTION_STATUSES.PENDING_CONFIRMATION)
      const pendingDigest = await sha256Digest(messages[0]!.token)
      expect((await harness.inspectConfirmationTokens()).find(
        token => token.digest === pendingDigest
      )?.revokedAt).toBeInstanceOf(Date)
      await service.unsuppressContact({ email })

      const events = await service.listEvents({ email })
      expect(events.map(event => event.type)).toEqual([
        NEWSLETTER_EVENT_TYPES.SIGNED_UP,
        NEWSLETTER_EVENT_TYPES.CONFIRMATION_REQUESTED,
        NEWSLETTER_EVENT_TYPES.CONFIRMATION_SENT,
        NEWSLETTER_EVENT_TYPES.SUBJECT_LINKED,
        NEWSLETTER_EVENT_TYPES.SUPPRESSED,
        NEWSLETTER_EVENT_TYPES.UNSUPPRESSED
      ])
      expect(JSON.stringify(events)).not.toContain(email)
      expect(JSON.stringify(events)).not.toContain('private-subject')
      expect(JSON.stringify(events)).not.toContain('other')
      expect(JSON.stringify(events)).not.toContain(messages[0]!.token)
    })

    it('fences stale confirmation and unsubscribe capabilities after a new lifecycle generation', async () => {
      const { service, makeService, messages, settle, advance } = setup()
      const other = makeService()
      await service.subscribe({ email, consent: consent('v1') })
      await settle()
      const staleToken = messages[0]!.token
      await other.confirm({ token: staleToken })
      const staleLink = (await service.createUnsubscribeCapability({ email }))!
      const staleAll = (await service.createUnsubscribeCapability({ email, all: true }))!
      await service.unsubscribe({ capability: staleLink })

      advance(1_000)
      await other.subscribe({ email, consent: consent('v2') })
      await settle()

      const contact = await service.getContact({ email })
      const subscription = await service.getSubscription({ email })
      expect(contact?.capabilityGeneration).toBe(2)
      expect(subscription?.lifecycleGeneration).toBe(2)
      expect(Number.isSafeInteger(contact?.capabilityGeneration)).toBe(true)
      expect(Number.isSafeInteger(subscription?.lifecycleGeneration)).toBe(true)
      expect(subscription?.consent.version).toBe('v2')
      await expect(service.confirm({ token: staleToken }))
        .resolves.toEqual({ confirmed: false })
      await expect(other.unsubscribe({ capability: staleLink }))
        .resolves.toEqual({ unsubscribed: false })
      await expect(other.unsubscribeAll({ capability: staleAll }))
        .resolves.toEqual({ unsubscribed: false })
      await expect(other.confirm({ token: messages[1]!.token }))
        .resolves.toEqual({ confirmed: true })
    })

    it('serializes parallel first signups for the same normalized email and audience', async () => {
      const { service, makeService, messages, settle } = setup()
      const other = makeService()
      const requests = Array.from({ length: 6 }, (_, index) =>
        (index % 2 === 0 ? service : other).subscribe({
          email: index % 3 === 0 ? ' Person@Example.COM ' : email,
          consent: consent()
        })
      )

      await expect(Promise.all(requests)).resolves.toEqual(
        Array.from({ length: 6 }, () => ({ accepted: true }))
      )
      await settle()

      expect(await service.getContact({ email })).not.toBeNull()
      expect(await service.listSubscriptions({ email })).toHaveLength(1)
      expect(messages).toHaveLength(1)
    })

    it('serializes confirmation races with per-audience unsubscribe and contact suppression', async () => {
      for (const action of ['unsubscribe', 'suppress'] as const) {
        await harness.reset()
        const address = `${action}@example.com`
        const { service, makeService, messages, settle } = setup()
        const other = makeService()
        await service.subscribe({ email: address, consent: consent() })
        await settle()
        const token = messages[0]!.token
        const capability = (await service.createUnsubscribeCapability({ email: address }))!

        const [confirmation, transition] = await Promise.all([
          service.confirm({ token }),
          action === 'unsubscribe'
            ? other.unsubscribe({ capability })
            : other.suppressContact({ email: address, reason: 'BOUNCE' })
        ])
        expect(typeof confirmation.confirmed).toBe('boolean')

        if (action === 'unsubscribe') {
          expect(transition).toEqual({ unsubscribed: true })
          expect((await service.getSubscription({ email: address }))?.status)
            .toBe(SUBSCRIPTION_STATUSES.UNSUBSCRIBED)
        } else {
          expect(transition).toMatchObject({ status: CONTACT_STATUSES.SUPPRESSED })
        }
        await expect(other.confirm({ token })).resolves.toEqual({ confirmed: false })
      }
    })

    it('serializes simultaneous audience additions and invalidates an earlier unsubscribe-all capability', async () => {
      const { service, makeService, settle } = setup()
      await service.subscribe({ email, consent: consent() })
      await settle()
      const oldAll = (await service.createUnsubscribeCapability({ email, all: true }))!
      const other = makeService()
      const audiences = ['product', 'engineering', 'events', 'offers']

      await expect(Promise.all(audiences.map((audience, index) =>
        (index % 2 === 0 ? service : other).subscribe({
          email,
          audience,
          consent: consent(audience)
        })
      ))).resolves.toEqual(audiences.map(() => ({ accepted: true })))
      await settle()

      expect((await service.getContact({ email }))?.capabilityGeneration)
        .toBe(audiences.length + 1)
      expect(new Set((await service.listSubscriptions({ email })).map(row => row.audienceKey)))
        .toEqual(new Set(['default', ...audiences]))
      await expect(other.unsubscribeAll({ capability: oldAll }))
        .resolves.toEqual({ unsubscribed: false })
    })

    it('rejects contact-wide work resolved before a newer audience transition', async () => {
      const { service, makeService, settle } = setup()
      await service.subscribe({ email, consent: consent() })
      await settle()
      const capability = (await service.createUnsubscribeCapability({ email, all: true }))!
      const other = makeService()
      const resolved = gate()
      const resume = gate()
      const original = other.capabilities.resolveUnsubscribeCapability

      vi.spyOn(other.capabilities, 'resolveUnsubscribeCapability')
        .mockImplementationOnce(async value => {
          const target = await original(value)
          resolved.release()
          await resume.promise
          return target
        })

      const stale = other.unsubscribeAll({ capability })
      try {
        await resolved.promise
        await service.subscribe({ email, audience: 'product', consent: consent() })
        await settle()
      } finally {
        resume.release()
      }

      await expect(stale).resolves.toEqual({ unsubscribed: false })
      expect((await service.listSubscriptions({ email })).map(row => row.status))
        .toEqual([
          SUBSCRIPTION_STATUSES.PENDING_CONFIRMATION,
          SUBSCRIPTION_STATUSES.PENDING_CONFIRMATION
        ])
    })

    it('leases delivery work across service instances and retries only after lease expiry', async () => {
      const { makeService, messages, advance, setDelivery, settle } = setup()
      const first = makeService({ confirmation: { deliveryLeaseMs: 1_000 } })
      const second = makeService({ confirmation: { deliveryLeaseMs: 1_000 } })
      const oldSend = gate()
      const newSend = gate()

      setDelivery(async input => {
        await (input.attemptId === messages[0]?.attemptId
          ? oldSend.promise
          : newSend.promise)
        return { accepted: true }
      })

      try {
        await first.subscribe({ email, consent: consent() })
        await vi.waitFor(() => expect(messages).toHaveLength(1))
        const previous = (await first.getSubscription({ email }))!.confirmationDelivery!
        expect(previous.attemptId).toBe(messages[0]!.attemptId)

        advance(999)
        await second.resendConfirmation({ email })
        await vi.waitFor(async () => {
          const events = await second.listEvents({ email })
          expect(events.filter(event =>
            event.type === NEWSLETTER_EVENT_TYPES.CONFIRMATION_REQUESTED
          )).toHaveLength(1)
        })
        expect(messages).toHaveLength(1)

        advance(1)
        await second.resendConfirmation({ email })
        await vi.waitFor(() => expect(messages).toHaveLength(2))
        const current = (await second.getSubscription({ email }))!.confirmationDelivery!
        expect(current.id).toBe(previous.id)
        expect(current.attemptId).not.toBe(previous.attemptId)
        expect(current.leaseExpiresAt).toBeInstanceOf(Date)

        oldSend.release()
        await vi.waitFor(async () => {
          const events = await first.listEvents({ email })
          expect(events.filter(event =>
            event.type === NEWSLETTER_EVENT_TYPES.CONFIRMATION_STALE_RESULT
          )).toHaveLength(1)
        })
        expect(await second.getSubscription({ email })).toMatchObject({
          confirmationDelivery: current,
          confirmationSentAt: null
        })
      } finally {
        oldSend.release()
        newSend.release()
      }

      await settle()
      const events = await second.listEvents({ email })
      expect(events.filter(event => event.type === NEWSLETTER_EVENT_TYPES.CONFIRMATION_SENT))
        .toHaveLength(1)
      expect((await second.getSubscription({ email }))?.confirmationDelivery).toBeNull()
      await expect(first.confirm({ token: messages[1]!.token }))
        .resolves.toEqual({ confirmed: true })
    })

    it('applies fixed-window rate limits atomically across limiter instances', async () => {
      let nowMs = baseTime
      const clock = { now: () => new Date(nowMs) }
      const first = harness.createRateLimiter(clock)
      const second = harness.createRateLimiter(clock)
      const provider = createHmacRateLimitKeyProvider({ secret })
      const key = await provider.createKey({
        action: 'subscribe',
        email,
        audienceKey: 'default'
      })
      const concurrentKey = await provider.createKey({
        action: 'subscribe',
        email: 'parallel@example.com',
        audienceKey: 'default'
      })

      await expect(first.consume({
        key,
        action: 'subscribe',
        limit: 2,
        windowMs: 60_000
      })).resolves.toEqual({ allowed: true })
      await expect(second.consume({
        key,
        action: 'subscribe',
        limit: 2,
        windowMs: 60_000
      })).resolves.toEqual({ allowed: true })
      await expect(first.consume({
        key,
        action: 'subscribe',
        limit: 2,
        windowMs: 60_000
      })).resolves.toMatchObject({ allowed: false })

      await expect(first.consume({
        key,
        action: 'subscribe',
        limit: 1,
        windowMs: 30_000
      })).resolves.toEqual({ allowed: true })
      await expect(first.consume({
        key,
        action: 'resend-confirmation',
        limit: 1,
        windowMs: 60_000
      })).resolves.toEqual({ allowed: true })

      const attempts = await Promise.all(Array.from({ length: 20 }, (_, index) =>
        (index % 2 === 0 ? first : second).consume({
          key: concurrentKey,
          action: 'subscribe',
          limit: 5,
          windowMs: 60_000
        })
      ))
      expect(attempts.filter(result => result.allowed)).toHaveLength(5)
      expect(attempts.filter(result => !result.allowed)).toHaveLength(15)

      const rows = await harness.inspectRateLimits()
      expect(rows).toHaveLength(4)
      expect(JSON.stringify(rows)).not.toContain(email)
      expect(rows.every(row => row.key === key || row.key === concurrentKey)).toBe(true)
      expect(rows.find(row =>
        row.key === concurrentKey && row.action === 'subscribe' && row.windowMs === 60_000
      )?.attemptCount).toBe(20)

      nowMs += 60_000
      await expect(first.cleanup()).resolves.toBe(4)
      await expect(second.consume({
        key,
        action: 'subscribe',
        limit: 2,
        windowMs: 60_000
      })).resolves.toEqual({ allowed: true })
    })

    it('enforces adapter-backed signup rate limiting before creating additional lifecycle state', async () => {
      const { makeService, clock, settle } = setup()
      const hmacProvider = createHmacRateLimitKeyProvider({ secret })
      const service = makeService({
        rateLimiter: harness.createRateLimiter(clock),
        rateLimitKeyProvider: {
          async createKey(input: {
            readonly action: PublicAbuseAction
            readonly email: string
            readonly audienceKey: string
            readonly context?: unknown
          }) {
            return hmacProvider.createKey(input)
          }
        },
        rateLimits: { subscribe: { limit: 1, windowMs: 60_000 } }
      })

      await service.subscribe({ email, consent: consent() })
      await expect(service.subscribe({ email, consent: consent() }))
        .rejects.toMatchObject({ code: NEWSLETTER_ERROR_CODES.RATE_LIMITED })
      await settle()

      expect(await service.getContact({ email })).not.toBeNull()
      expect(await service.listSubscriptions({ email })).toHaveLength(1)
      const rows = await harness.inspectRateLimits()
      expect(rows).toHaveLength(1)
      expect(JSON.stringify(rows)).not.toContain(email)
    })
  })
}
