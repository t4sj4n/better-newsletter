import { readFileSync } from 'node:fs'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  CONTACT_STATUSES,
  NEWSLETTER_EVENT_TYPES,
  SUBSCRIPTION_STATUSES,
  betterNewsletter
} from '../packages/better-newsletter/src/index.js'
import { createSecureCapabilities, sha256Digest } from '../packages/better-newsletter/src/security.js'
import { memoryCapabilities } from '../packages/better-newsletter/src/adapters/memory.js'
import {
  listEligibleSubscriptions,
  postgresRateLimiter,
  postgresAdapter
} from '../packages/better-newsletter/src/adapters/postgres.js'
import {
  registerStorageAdapterConformance,
  type StoredConfirmationTokenSnapshot,
  type StoredRateLimitSnapshot
} from './storage-conformance.js'

const databaseUrl = process.env.DATABASE_URL

describe.skipIf(!databaseUrl)('PostgreSQL integration', () => {
  const schema = `newsletter_test_${crypto.randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 2 })
  const pool = new Pool({
    connectionString: databaseUrl,
    options: `-c search_path=${schema}`,
    max: 20
  })
  const db = new Kysely<Record<string, never>>({
    dialect: new PostgresDialect({ pool })
  })

  async function reset() {
    await pool.query(
      'TRUNCATE newsletter_contacts, newsletter_rate_limits, newsletter_suppression_keys RESTART IDENTITY CASCADE'
    )
  }

  async function inspectConfirmationTokens(): Promise<
    readonly StoredConfirmationTokenSnapshot[]
  > {
    const result = await pool.query<{
      digest: string
      lifecycle_generation: string
      created_at: Date
      expires_at: Date
      consumed_at: Date | null
      revoked_at: Date | null
    }>(
      `SELECT digest, lifecycle_generation, created_at, expires_at,
              consumed_at, revoked_at
       FROM newsletter_tokens
       ORDER BY id`
    )
    return result.rows.map(row => ({
      digest: row.digest,
      lifecycleGeneration: Number(row.lifecycle_generation),
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      consumedAt: row.consumed_at,
      revokedAt: row.revoked_at
    }))
  }

  async function inspectRateLimits(): Promise<readonly StoredRateLimitSnapshot[]> {
    const result = await pool.query<{
      key_hash: string
      action: string
      window_ms: string
      bucket_start_ms: string
      attempt_count: number
    }>(
      `SELECT key_hash, action, window_ms, bucket_start_ms, attempt_count
       FROM newsletter_rate_limits
       ORDER BY action, key_hash, window_ms, bucket_start_ms`
    )
    return result.rows.map(row => ({
      key: row.key_hash,
      action: row.action,
      windowMs: Number(row.window_ms),
      bucketStartMs: Number(row.bucket_start_ms),
      attemptCount: row.attempt_count
    }))
  }

  it('serializes trusted token creation across PostgreSQL services with digest-only persistence', async () => {
    const storage = postgresAdapter(db)
    const options = {
      storage,
      capabilities: createSecureCapabilities({ hmacSecret: '0123456789abcdef0123456789abcdef' }),
      mailer: { async sendConfirmation(): Promise<never> { throw new Error('Trusted issuance must not send mail') } },
      confirmation: { replacementStrategy: 'REPLACE_PREVIOUS' as const, expiresInMs: 60_000 },
      transactionMaxAttempts: 20
    }
    const first = betterNewsletter(options)
    const second = betterNewsletter(options)
    const subscription = await first.importSubscription({
      email: 'trusted@example.com', status: 'PENDING_CONFIRMATION',
      consent: { version: 'v1', consentedAt: new Date() }
    })
    const input = { subscription: { id: subscription.id } }
    const results = await Promise.all(Array.from({ length: 6 }, (_, index) =>
      (index % 2 ? first : second).createConfirmationToken({
        ...input, eventMetadata: { actorId: `admin-${index}`, audienceKey: 'fake', lifecycleGeneration: 999 }
      })
    ))
    expect(results.every(Boolean)).toBe(true)
    const stored = await inspectConfirmationTokens()
    expect(stored).toHaveLength(6)
    const active = stored.filter(t => t.revokedAt == null && t.consumedAt == null)
    expect(active).toHaveLength(1)
    expect(await first.getConfirmationState(input)).toEqual({
      canCreate: true, reason: null, activeTokenExpiresAt: active[0]!.expiresAt
    })
    for (const result of results) {
      expect(stored.some(t => t.digest === result!.token)).toBe(false)
    }
    const digests = await Promise.all(results.map(result => sha256Digest(result!.token)))
    expect(stored.map(t => t.digest).sort()).toEqual(digests.sort())
    const createdEvents = (await first.listEvents({ email: 'trusted@example.com' }))
      .filter(e => e.type === 'CONFIRMATION_TOKEN_CREATED')
    expect(createdEvents).toHaveLength(6)
    expect(createdEvents.map(e => e.metadata.actorId).sort()).toEqual(
      Array.from({ length: 6 }, (_, index) => `admin-${index}`)
    )
    for (const event of createdEvents) {
      expect(event.metadata).toMatchObject({
        audienceKey: subscription.audienceKey, lifecycleGeneration: subscription.lifecycleGeneration
      })
    }
    const confirmed = await Promise.all(results.map(result => first.confirm({ token: result!.token })))
    expect(confirmed.filter(result => result.confirmed)).toHaveLength(1)
  })

  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA "${schema}"`)
    const migration = readFileSync(
      new URL('../packages/better-newsletter/migrations/postgres/001_newsletter.sql', import.meta.url),
      'utf8'
    )
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(migration)
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  })

  afterAll(async () => {
    await db.destroy()
    try {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    } finally {
      await admin.end()
    }
  })

  registerStorageAdapterConformance({
    name: 'PostgreSQL',
    reset,
    createStorage: () => postgresAdapter(db),
    createRateLimiter: clock => postgresRateLimiter(db, clock),
    inspectConfirmationTokens,
    inspectRateLimits
  })

  describe('PostgreSQL-specific behavior', () => {
    beforeEach(reset)

    it('replaces all previous trusted tokens per call while retaining the global PostgreSQL policy', async () => {
      const newsletter = betterNewsletter({
        storage: postgresAdapter(db),
        capabilities: createSecureCapabilities({ hmacSecret: '0123456789abcdef0123456789abcdef' }),
        mailer: { async sendConfirmation(): Promise<never> { throw new Error('Trusted issuance must not send mail') } },
        confirmation: { replacementStrategy: 'RETAIN_PREVIOUS_UNTIL_EXPIRY', maxActiveTokens: 4 }
      })
      const subscription = await newsletter.importSubscription({
        email: 'replacement@example.com', status: 'PENDING_CONFIRMATION',
        consent: { version: 'v1', consentedAt: new Date() }
      })
      const input = { subscription: { id: subscription.id } }
      const first = (await newsletter.createConfirmationToken(input))!
      const second = (await newsletter.createConfirmationToken(input))!
      expect((await inspectConfirmationTokens()).filter(token => token.revokedAt == null)).toHaveLength(2)
      const replacement = (await newsletter.createConfirmationToken({
        ...input, replacementStrategy: 'REPLACE_PREVIOUS', eventMetadata: { actorId: 'admin-123' }
      }))!
      expect(await newsletter.confirm({ token: first.token })).toEqual({ confirmed: false })
      expect(await newsletter.confirm({ token: second.token })).toEqual({ confirmed: false })
      const retained = (await newsletter.createConfirmationToken(input))!
      expect((await inspectConfirmationTokens()).filter(token => token.revokedAt == null)).toHaveLength(2)
      expect(await newsletter.confirm({ token: replacement.token })).toEqual({ confirmed: true })
      expect(retained).not.toBeNull()
      expect((await newsletter.listEvents({ email: 'replacement@example.com' })).find(event =>
        event.type === 'CONFIRMATION_TOKEN_CREATED' && event.metadata.actorId === 'admin-123'
      )).toBeDefined()
    })

    it('paginates exact bigint sequences using the existing bounded index query', async () => {
      const storage = postgresAdapter(db)
      const service = betterNewsletter({
        storage, capabilities: memoryCapabilities(),
        mailer: { async sendConfirmation() { return { accepted: true } } }
      })
      const subscription = await service.importSubscription({
        email: 'bigint@example.com', status: 'PENDING_CONFIRMATION',
        consent: { version: 'v1', consentedAt: new Date() }
      })
      await pool.query("ALTER TABLE newsletter_events ALTER COLUMN sequence RESTART WITH 9007199254740993")
      await storage.transaction(async transaction => {
        for (let index = 0; index < 4; index += 1) {
          await transaction.appendEvent({
            id: `bigint-${index}`, contactId: subscription.contactId, subscriptionId: subscription.id,
            type: NEWSLETTER_EVENT_TYPES.SIGNED_UP, occurredAt: new Date('2026-09-28T08:00:00Z'), metadata: {}
          })
        }
      })
      const first = await service.listSubscriptionEvents({ subscription: { id: subscription.id }, limit: 2 })
      expect(first.events.map(event => event.id)).toEqual(['bigint-3', 'bigint-2'])
      const second = await service.listSubscriptionEvents({
        subscription: { id: subscription.id }, limit: 2, cursor: first.nextCursor!
      })
      expect(second.events.map(event => event.id)).toEqual(['bigint-1', 'bigint-0'])
      const last = await service.listSubscriptionEvents({
        subscription: { id: subscription.id }, limit: 2, cursor: second.nextCursor!
      })
      expect(last.events).toHaveLength(1)
      expect(last.nextCursor).toBeNull()
      const plan = await pool.connect()
      try {
        await plan.query('BEGIN')
        await plan.query('SET LOCAL enable_seqscan = off')
        const result = await plan.query<{ 'QUERY PLAN': string }>(
          `EXPLAIN SELECT *, sequence::text AS cursor_sequence FROM newsletter_events
           WHERE subscription_id = $1 AND sequence < $2::bigint ORDER BY sequence DESC LIMIT $3`,
          [subscription.id, '9007199254740995', 3]
        )
        const text = result.rows.map(row => row['QUERY PLAN']).join('\n')
        expect(text).toContain('Limit')
        expect(text).toContain('newsletter_events_subscription_sequence_idx')
        expect(text).toContain('sequence <')
      } finally {
        await plan.query('ROLLBACK')
        plan.release()
      }
    })

    it('exports and anonymizes persisted contact data without leaving direct metadata or tokens', async () => {
      const storage = postgresAdapter(db)
      const now = new Date('2026-09-29T08:00:00.000Z')
      const newsletter = betterNewsletter({
        storage, capabilities: memoryCapabilities(),
        mailer: { async sendConfirmation() { return { accepted: true } } },
        clock: { now: () => now }
      })
      await storage.transaction(async transaction => {
        await transaction.createContact({
          id: 'privacy-contact', capabilityGeneration: 1,
          email: 'private@example.com', status: CONTACT_STATUSES.ENABLED,
          subject: { namespace: 'user', id: 'private-user' },
          metadata: { email: 'private@example.com' },
          createdAt: now, updatedAt: now
        })
        await transaction.createSubscription({
          id: 'privacy-subscription', lifecycleGeneration: 1,
          contactId: 'privacy-contact', audienceKey: 'private-audience',
          status: SUBSCRIPTION_STATUSES.PENDING_CONFIRMATION,
          consent: { version: 'v1', source: 'private@example.com', consentedAt: now },
          confirmationDelivery: null, createdAt: now, updatedAt: now
        })
        await transaction.confirmationTokens.replace({
          record: {
            digest: 'private-token-digest', purpose: 'CONFIRMATION',
            contactId: 'privacy-contact', subscriptionId: 'privacy-subscription',
            lifecycleGeneration: 1, createdAt: now,
            expiresAt: new Date(now.getTime() + 60_000)
          },
          strategy: 'REPLACE_PREVIOUS', maxActiveTokens: 1, now
        })
        await transaction.appendEvent({
          id: 'privacy-event', contactId: 'privacy-contact',
          subscriptionId: 'privacy-subscription',
          type: NEWSLETTER_EVENT_TYPES.SIGNED_UP, occurredAt: now,
          metadata: { email: 'private@example.com' }
        })
      })
      expect((await newsletter.exportContactData({ id: 'privacy-contact' }))?.confirmationTokens)
        .toHaveLength(1)
      expect(await newsletter.eraseContactData({
        contact: { id: 'privacy-contact' }, strategy: 'ANONYMIZE'
      })).toEqual({ erased: true })
      const exported = await newsletter.exportContactData({ id: 'privacy-contact' })
      expect(JSON.stringify(exported)).not.toContain('private@example.com')
      expect(JSON.stringify(exported)).not.toContain('private-token-digest')
      expect(exported?.events[0]?.metadata).toEqual({})
      expect(exported?.confirmationTokens).toEqual([])
      const persisted = await pool.query<{ count: string }>(
        'SELECT count(*) FROM newsletter_tokens WHERE contact_id = $1', ['privacy-contact']
      )
      expect(persisted.rows[0]?.count).toBe('0')
    })

    it('bounds soft-bounce counts after the latest unsuppression', async () => {
      const storage = postgresAdapter(db)
      const now = new Date('2026-09-29T08:00:00.000Z')
      await storage.transaction(async transaction => {
        await transaction.createContact({
          id: 'feedback-contact', capabilityGeneration: 1,
          email: 'feedback@example.com', status: CONTACT_STATUSES.ENABLED,
          subject: null, createdAt: now, updatedAt: now
        })
        for (const [index, type, feedbackType, providerTime] of [
          [1, NEWSLETTER_EVENT_TYPES.PROVIDER_FEEDBACK, 'SOFT_BOUNCE', new Date(now.getTime() - 60_000)],
          [2, NEWSLETTER_EVENT_TYPES.PROVIDER_FEEDBACK, 'DELIVERED', now],
          [3, NEWSLETTER_EVENT_TYPES.UNSUPPRESSED, null, now],
          [4, NEWSLETTER_EVENT_TYPES.PROVIDER_FEEDBACK, 'SOFT_BOUNCE', new Date(now.getTime() + 60_000)],
          [5, NEWSLETTER_EVENT_TYPES.PROVIDER_FEEDBACK, 'SOFT_BOUNCE', new Date(now.getTime() + 120_000)],
          [6, NEWSLETTER_EVENT_TYPES.PROVIDER_FEEDBACK, 'SOFT_BOUNCE', new Date(now.getTime() - 60_000)]
        ] as const) {
          await transaction.appendEvent({
            id: `feedback-${index}`, contactId: 'feedback-contact',
            type, occurredAt: now,
            metadata: feedbackType == null ? {} : { feedbackType, feedbackOccurredAt: providerTime.toISOString() }
          })
        }
        expect(await transaction.latestUnsuppressedAt('feedback-contact')).toEqual(now)
        expect(await transaction.countSoftBouncesAfter('feedback-contact', now, 1)).toBe(1)
        expect(await transaction.countSoftBouncesAfter('feedback-contact', now, 2)).toBe(2)
        expect(await transaction.countSoftBouncesAfter('feedback-contact', null, 4)).toBe(4)
        expect(await transaction.listEvents('feedback-contact')).toHaveLength(6)
      })
    })

    it('removes retained suppression keys transactionally and idempotently', async () => {
      const storage = postgresAdapter(db)
      const key = 'a'.repeat(64)
      await storage.transaction(transaction => transaction.retainSuppressionKey(key))
      expect(await storage.transaction(transaction => transaction.removeSuppressionKey(key))).toBe(true)
      expect(await storage.transaction(transaction => transaction.removeSuppressionKey(key))).toBe(false)
      expect(await storage.transaction(transaction => transaction.hasSuppressionKey(key))).toBe(false)
    })

    it('applies native normalization and uniqueness constraints from the migration', async () => {
      const now = new Date('2026-09-28T08:00:00.000Z')

      await expect(pool.query(
        `INSERT INTO newsletter_contacts
          (id, email, status, created_at, updated_at)
         VALUES ($1, $2, 'ENABLED', $3, $3)`,
        ['invalid-email', ' Person@Example.COM ', now]
      )).rejects.toMatchObject({ code: '23514' })

      await pool.query(
        `INSERT INTO newsletter_contacts
          (id, email, status, created_at, updated_at)
         VALUES ($1, $2, 'ENABLED', $3, $3)`,
        ['contact-1', 'person@example.com', now]
      )
      await expect(pool.query(
        `INSERT INTO newsletter_contacts
          (id, email, status, created_at, updated_at)
         VALUES ($1, $2, 'ENABLED', $3, $3)`,
        ['contact-2', 'person@example.com', now]
      )).rejects.toMatchObject({ code: '23505' })

      await pool.query(
        `INSERT INTO newsletter_subscriptions
          (id, contact_id, audience_key, status, consent_version, consented_at,
           created_at, updated_at)
         VALUES ($1, $2, 'default', 'PENDING_CONFIRMATION', 'v1', $3, $3, $3)`,
        ['subscription-1', 'contact-1', now]
      )
      await expect(pool.query(
        `INSERT INTO newsletter_subscriptions
          (id, contact_id, audience_key, status, consent_version, consented_at,
           created_at, updated_at)
         VALUES ($1, $2, 'default', 'PENDING_CONFIRMATION', 'v1', $3, $3, $3)`,
        ['subscription-2', 'contact-1', now]
      )).rejects.toMatchObject({ code: '23505' })
    })

    it('selects only PostgreSQL recipients that satisfy core delivery eligibility', async () => {
      const storage = postgresAdapter(db)
      const now = new Date('2026-09-28T08:00:00.000Z')

      await storage.transaction(async transaction => {
        const contact = await transaction.createContact({
          id: 'eligible-contact',
          capabilityGeneration: 1,
          email: 'eligible@example.com',
          status: CONTACT_STATUSES.ENABLED,
          subject: null,
          metadata: { tier: 'pro' },
          createdAt: now,
          updatedAt: now
        })
        await transaction.createSubscription({
          id: 'eligible-subscription',
          lifecycleGeneration: 1,
          contactId: contact.id,
          audienceKey: 'default',
          status: SUBSCRIPTION_STATUSES.ACTIVE,
          consent: {
            version: 'v1',
            source: 'import',
            locale: 'en',
            consentedAt: now
          },
          confirmationDelivery: null,
          confirmationSentAt: now,
          confirmedAt: now,
          unsubscribedAt: null,
          createdAt: now,
          updatedAt: now
        })

        const ineligible = [
          {
            id: 'pending',
            status: SUBSCRIPTION_STATUSES.PENDING_CONFIRMATION,
            confirmedAt: null,
            unsubscribedAt: null
          },
          {
            id: 'unsubscribed',
            status: SUBSCRIPTION_STATUSES.UNSUBSCRIBED,
            confirmedAt: now,
            unsubscribedAt: now
          },
          {
            id: 'unconfirmed',
            status: SUBSCRIPTION_STATUSES.ACTIVE,
            confirmedAt: null,
            unsubscribedAt: null
          },
          {
            id: 'ended',
            status: SUBSCRIPTION_STATUSES.ACTIVE,
            confirmedAt: now,
            unsubscribedAt: now
          }
        ] as const

        for (const candidate of ineligible) {
          const other = await transaction.createContact({
            id: `${candidate.id}-contact`,
            capabilityGeneration: 1,
            email: `${candidate.id}@example.com`,
            status: CONTACT_STATUSES.ENABLED,
            subject: null,
            metadata: {},
            createdAt: now,
            updatedAt: now
          })
          await transaction.createSubscription({
            id: `${candidate.id}-subscription`,
            lifecycleGeneration: 1,
            contactId: other.id,
            audienceKey: 'default',
            status: candidate.status,
            consent: {
              version: 'v1',
              source: 'import',
              locale: 'en',
              consentedAt: now
            },
            confirmationDelivery: null,
            confirmationSentAt: now,
            confirmedAt: candidate.confirmedAt,
            unsubscribedAt: candidate.unsubscribedAt,
            createdAt: now,
            updatedAt: now
          })
        }
      })

      const eligible = await listEligibleSubscriptions(db, 'default')
      expect(eligible.map(row => row.contact.email)).toEqual(['eligible@example.com'])
      expect(eligible[0]?.contact).toMatchObject({
        email: 'eligible@example.com',
        metadata: { tier: 'pro' }
      })
      expect(eligible[0]?.subscription.confirmedAt).toBeInstanceOf(Date)

      await storage.transaction(async transaction => {
        await transaction.updateContact('eligible-contact', {
          status: CONTACT_STATUSES.SUPPRESSED,
          suppressedAt: now,
          suppressionReason: 'TEST',
          updatedAt: now
        })
      })
      expect(await listEligibleSubscriptions(db, 'default')).toEqual([])
      expect(await listEligibleSubscriptions(db, 'other')).toEqual([])
    })

    it('cascades explicit PostgreSQL Contact erasure to dependent persistence', async () => {
      const storage = postgresAdapter(db)
      const now = new Date('2026-09-28T08:00:00.000Z')

      await storage.transaction(async transaction => {
        const contact = await transaction.createContact({
          id: 'erase-contact',
          capabilityGeneration: 1,
          email: 'erase@example.com',
          status: CONTACT_STATUSES.ENABLED,
          subject: null,
          metadata: { private: 'redact-me' },
          createdAt: now,
          updatedAt: now
        })
        const subscription = await transaction.createSubscription({
          id: 'erase-subscription',
          lifecycleGeneration: 1,
          contactId: contact.id,
          audienceKey: 'default',
          status: SUBSCRIPTION_STATUSES.PENDING_CONFIRMATION,
          consent: { version: 'v1', consentedAt: now },
          confirmationDelivery: null,
          createdAt: now,
          updatedAt: now
        })
        await transaction.confirmationTokens.replace({
          record: {
            digest: 'erase-token-digest',
            purpose: 'CONFIRMATION',
            contactId: contact.id,
            subscriptionId: subscription.id,
            lifecycleGeneration: 1,
            createdAt: now,
            expiresAt: new Date(now.getTime() + 60_000)
          },
          strategy: 'RETAIN_PREVIOUS_UNTIL_EXPIRY',
          maxActiveTokens: 2,
          now
        })
        await transaction.appendEvent({
          id: 'erase-event',
          contactId: contact.id,
          subscriptionId: subscription.id,
          type: NEWSLETTER_EVENT_TYPES.SIGNED_UP,
          occurredAt: now,
          metadata: { audienceKey: 'default' }
        })
      })

      await pool.query('DELETE FROM newsletter_contacts WHERE id = $1', ['erase-contact'])

      for (const table of [
        'newsletter_subscriptions',
        'newsletter_tokens',
        'newsletter_events'
      ]) {
        const result = await pool.query<{ count: string }>(
          `SELECT count(*) FROM ${table} WHERE contact_id = $1`,
          ['erase-contact']
        )
        expect(result.rows[0]?.count).toBe('0')
      }
      await expect(storage.transaction(transaction =>
        transaction.getContactById('erase-contact')
      )).resolves.toBeNull()
    })
  })
})
