import { readFileSync } from 'node:fs'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  CONTACT_STATUSES,
  NEWSLETTER_EVENT_TYPES,
  SUBSCRIPTION_STATUSES
} from '../packages/better-newsletter/src/index.js'
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
      'TRUNCATE newsletter_contacts, newsletter_rate_limits RESTART IDENTITY CASCADE'
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

    it('bounds soft-bounce counts after the latest unsuppression', async () => {
      const storage = postgresAdapter(db)
      const now = new Date('2026-09-29T08:00:00.000Z')
      await storage.transaction(async transaction => {
        await transaction.createContact({
          id: 'feedback-contact', capabilityGeneration: 1,
          email: 'feedback@example.com', status: CONTACT_STATUSES.ENABLED,
          subject: null, createdAt: now, updatedAt: now
        })
        for (const [index, type, feedbackType] of [
          [1, NEWSLETTER_EVENT_TYPES.PROVIDER_FEEDBACK, 'SOFT_BOUNCE'],
          [2, NEWSLETTER_EVENT_TYPES.PROVIDER_FEEDBACK, 'DELIVERED'],
          [3, NEWSLETTER_EVENT_TYPES.UNSUPPRESSED, null],
          [4, NEWSLETTER_EVENT_TYPES.PROVIDER_FEEDBACK, 'SOFT_BOUNCE'],
          [5, NEWSLETTER_EVENT_TYPES.PROVIDER_FEEDBACK, 'SOFT_BOUNCE']
        ] as const) {
          await transaction.appendEvent({
            id: `feedback-${index}`, contactId: 'feedback-contact',
            type, occurredAt: now,
            metadata: feedbackType == null ? {} : { feedbackType }
          })
        }
        expect(await transaction.countSoftBouncesSinceUnsuppressed('feedback-contact', 1)).toBe(1)
        expect(await transaction.countSoftBouncesSinceUnsuppressed('feedback-contact', 2)).toBe(2)
        expect(await transaction.listEvents('feedback-contact')).toHaveLength(5)
      })
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
