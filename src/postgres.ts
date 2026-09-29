import { sql, type Kysely, type RawBuilder, type Transaction } from 'kysely'
import type {
  Contact,
  ContactStatus,
  JsonValue,
  NewsletterEvent,
  NewsletterEventType,
  Subscription,
  SubscriptionStatus
} from './domain.js'
import { StorageConflictError } from './errors.js'
import type {
  ConfirmationTokenRecord,
  ConfirmationTokenStore,
  PublicAbuseAction,
  RateLimiter
} from './security.js'
import type {
  ContactPatch,
  CreateContactInput,
  CreateSubscriptionInput,
  NewsletterStorage,
  NewsletterStorageTransaction,
  SubscriptionPatch
} from './storage.js'

interface ContactRow {
  id: string
  capability_generation: string
  email: string
  status: ContactStatus
  subject_namespace: string | null
  subject_id: string | null
  metadata: Record<string, JsonValue> | null
  suppressed_at: Date | string | null
  suppression_reason: string | null
  created_at: Date | string
  updated_at: Date | string
}

interface SubscriptionRow {
  id: string
  lifecycle_generation: string
  contact_id: string
  audience_key: string
  status: SubscriptionStatus
  consent_version: string
  consent_source: string | null
  consent_locale: string | null
  consented_at: Date
  confirmation_delivery_id: string | null
  confirmation_attempt_id: string | null
  confirmation_lease_expires_at: Date | null
  confirmation_sent_at: Date | null
  confirmed_at: Date | null
  unsubscribed_at: Date | null
  created_at: Date
  updated_at: Date
}

interface TokenRow {
  digest: string
  purpose: 'CONFIRMATION'
  contact_id: string
  subscription_id: string
  lifecycle_generation: string
  created_at: Date
  expires_at: Date
  consumed_at: Date | null
  revoked_at: Date | null
}

interface EventRow {
  id: string
  contact_id: string
  subscription_id: string | null
  event_type: NewsletterEventType
  occurred_at: Date
  metadata: Record<string, JsonValue>
}

function generation(value: string): number {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new Error('A stored capability generation exceeds the safe integer range.')
  }
  return number
}

function contactFromRow(row: ContactRow): Contact {
  return {
    id: row.id,
    capabilityGeneration: generation(row.capability_generation),
    email: row.email,
    status: row.status,
    subject: row.subject_namespace == null || row.subject_id == null
      ? null
      : { namespace: row.subject_namespace, id: row.subject_id },
    ...(row.metadata == null ? {} : { metadata: row.metadata }),
    suppressedAt: row.suppressed_at == null ? null : new Date(row.suppressed_at),
    suppressionReason: row.suppression_reason,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at)
  }
}

function subscriptionFromRow(row: SubscriptionRow): Subscription {
  return {
    id: row.id,
    lifecycleGeneration: generation(row.lifecycle_generation),
    contactId: row.contact_id,
    audienceKey: row.audience_key,
    status: row.status,
    consent: {
      version: row.consent_version,
      source: row.consent_source,
      locale: row.consent_locale,
      consentedAt: row.consented_at
    },
    confirmationDelivery: row.confirmation_delivery_id == null
      ? null
      : {
          id: row.confirmation_delivery_id,
          attemptId: row.confirmation_attempt_id,
          leaseExpiresAt: row.confirmation_lease_expires_at
        },
    confirmationSentAt: row.confirmation_sent_at,
    confirmedAt: row.confirmed_at,
    unsubscribedAt: row.unsubscribed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function tokenFromRow(row: TokenRow): ConfirmationTokenRecord {
  return {
    digest: row.digest,
    purpose: row.purpose,
    contactId: row.contact_id,
    subscriptionId: row.subscription_id,
    lifecycleGeneration: generation(row.lifecycle_generation),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
    revokedAt: row.revoked_at
  }
}

function eventFromRow(row: EventRow): NewsletterEvent {
  return {
    id: row.id,
    contactId: row.contact_id,
    subscriptionId: row.subscription_id,
    type: row.event_type,
    occurredAt: row.occurred_at,
    metadata: row.metadata
  }
}

function json(value: Readonly<Record<string, JsonValue>>): RawBuilder<unknown> {
  return sql`${JSON.stringify(value)}::jsonb`
}

function deliveryFields(delivery: Subscription['confirmationDelivery']): RawBuilder<unknown>[] {
  return [
    sql`confirmation_delivery_id = ${delivery?.id ?? null}`,
    sql`confirmation_attempt_id = ${delivery?.attemptId ?? null}`,
    sql`confirmation_lease_expires_at = ${delivery?.leaseExpiresAt ?? null}`
  ]
}

function consentFields(consent: Subscription['consent']): RawBuilder<unknown>[] {
  return [
    sql`consent_version = ${consent.version}`,
    sql`consent_source = ${consent.source ?? null}`,
    sql`consent_locale = ${consent.locale ?? null}`,
    sql`consented_at = ${consent.consentedAt}`
  ]
}

function required<T>(rows: readonly T[], entity: string): T {
  const row = rows[0]
  if (row == null) throw new Error(`Unknown ${entity}.`)
  return row
}

class PostgresConfirmationTokenStore<DB> implements ConfirmationTokenStore {
  constructor(private readonly trx: Transaction<DB>) {}

  async replace(input: Parameters<ConfirmationTokenStore['replace']>[0]) {
    const { subscriptionId, lifecycleGeneration } = input.record
    const active = (await sql<TokenRow>`
      SELECT * FROM newsletter_tokens
      WHERE subscription_id = ${subscriptionId}
        AND lifecycle_generation = ${lifecycleGeneration}
        AND purpose = 'CONFIRMATION'
        AND consumed_at IS NULL AND revoked_at IS NULL
      ORDER BY created_at DESC, id DESC
    `.execute(this.trx)).rows
    const expired = active.filter(record => record.expires_at <= input.now)
    const unexpired = active.filter(record => record.expires_at > input.now)
    const replaced = input.strategy === 'REPLACE_PREVIOUS'
      ? unexpired
      : unexpired.slice(Math.max(0, input.maxActiveTokens - 1))

    const digests = [...expired, ...replaced].map(record => record.digest)
    if (digests.length > 0) {
      await sql`
        UPDATE newsletter_tokens SET revoked_at = ${input.now}
        WHERE digest IN (${sql.join(digests)})
          AND subscription_id = ${subscriptionId}
          AND lifecycle_generation = ${lifecycleGeneration}
          AND purpose = 'CONFIRMATION'
          AND consumed_at IS NULL AND revoked_at IS NULL
      `.execute(this.trx)
    }
    const record = input.record
    await sql`
      INSERT INTO newsletter_tokens
        (digest, purpose, contact_id, subscription_id, lifecycle_generation,
         created_at, expires_at, consumed_at, revoked_at)
      VALUES (${record.digest}, ${record.purpose}, ${record.contactId},
              ${record.subscriptionId}, ${record.lifecycleGeneration},
              ${record.createdAt}, ${record.expiresAt},
              ${record.consumedAt ?? null}, ${record.revokedAt ?? null})
    `.execute(this.trx)
    return { replacedCount: replaced.length, expiredCount: expired.length }
  }

  async resolve(input: Parameters<ConfirmationTokenStore['resolve']>[0]) {
    const result = await sql<TokenRow>`
      SELECT * FROM newsletter_tokens WHERE digest = ${input.digest}
        AND purpose = 'CONFIRMATION'
        AND consumed_at IS NULL AND revoked_at IS NULL
        AND expires_at > ${input.now}
    `.execute(this.trx)
    return result.rows[0] == null ? null : tokenFromRow(result.rows[0])
  }

  async consume(input: Parameters<ConfirmationTokenStore['consume']>[0]) {
    const result = await sql<TokenRow>`
      UPDATE newsletter_tokens SET consumed_at = ${input.now}
      WHERE digest = ${input.digest}
        AND purpose = 'CONFIRMATION'
        AND consumed_at IS NULL AND revoked_at IS NULL
        AND expires_at > ${input.now}
      RETURNING *
    `.execute(this.trx)
    return result.rows[0] == null ? null : tokenFromRow(result.rows[0])
  }

  async revokeBySubscription(input: Parameters<ConfirmationTokenStore['revokeBySubscription']>[0]) {
    const result = await sql<{ digest: string }>`
      UPDATE newsletter_tokens SET revoked_at = ${input.now}
      WHERE subscription_id = ${input.subscriptionId}
        AND lifecycle_generation = ${input.lifecycleGeneration}
        AND purpose = 'CONFIRMATION'
        AND consumed_at IS NULL AND revoked_at IS NULL
      RETURNING digest
    `.execute(this.trx)
    return result.rows.length
  }

  async cleanup(input: Parameters<ConfirmationTokenStore['cleanup']>[0]) {
    const result = await sql<{ digest: string }>`
      DELETE FROM newsletter_tokens
      WHERE purpose = 'CONFIRMATION'
        AND COALESCE(consumed_at, revoked_at, expires_at) <= ${input.deleteBefore}
      RETURNING digest
    `.execute(this.trx)
    return result.rows.length
  }
}

function transactionAdapter<DB>(trx: Transaction<DB>): NewsletterStorageTransaction {
  return {
    async getContactByEmail(email) {
      const result = await sql<ContactRow>`
        SELECT * FROM newsletter_contacts WHERE email = ${email}
      `.execute(trx)
      return result.rows[0] == null ? null : contactFromRow(result.rows[0])
    },
    async getContactById(id) {
      const result = await sql<ContactRow>`
        SELECT * FROM newsletter_contacts WHERE id = ${id}
      `.execute(trx)
      return result.rows[0] == null ? null : contactFromRow(result.rows[0])
    },
    async createContact(input: CreateContactInput) {
      const result = await sql<ContactRow>`
        INSERT INTO newsletter_contacts
          (id, capability_generation, email, status, subject_namespace,
           subject_id, metadata, suppressed_at, suppression_reason, created_at, updated_at)
        VALUES (${input.id}, ${input.capabilityGeneration}, ${input.email}, ${input.status},
                ${input.subject?.namespace ?? null}, ${input.subject?.id ?? null},
                ${json(input.metadata ?? {})}, ${input.suppressedAt ?? null},
                ${input.suppressionReason ?? null}, ${input.createdAt}, ${input.updatedAt})
        RETURNING *
      `.execute(trx)
      return contactFromRow(required(result.rows, 'contact'))
    },
    async updateContact(id: string, patch: ContactPatch) {
      const fields: RawBuilder<unknown>[] = []
      if (patch.capabilityGeneration !== undefined) {
        fields.push(sql`capability_generation = ${patch.capabilityGeneration}`)
      }
      if (patch.status !== undefined) fields.push(sql`status = ${patch.status}`)
      if (patch.subject !== undefined) {
        fields.push(sql`subject_namespace = ${patch.subject?.namespace ?? null}`)
        fields.push(sql`subject_id = ${patch.subject?.id ?? null}`)
      }
      if (patch.metadata !== undefined) fields.push(sql`metadata = ${json(patch.metadata)}`)
      if (patch.suppressedAt !== undefined) fields.push(sql`suppressed_at = ${patch.suppressedAt}`)
      if (patch.suppressionReason !== undefined) {
        fields.push(sql`suppression_reason = ${patch.suppressionReason}`)
      }
      if (patch.updatedAt !== undefined) fields.push(sql`updated_at = ${patch.updatedAt}`)
      if (fields.length === 0) throw new Error('Cannot update a contact with an empty patch.')
      const result = await sql<ContactRow>`
        UPDATE newsletter_contacts SET ${sql.join(fields)}
        WHERE id = ${id} RETURNING *
      `.execute(trx)
      return contactFromRow(required(result.rows, 'contact'))
    },
    async getSubscription(contactId, audienceKey) {
      const result = await sql<SubscriptionRow>`
        SELECT * FROM newsletter_subscriptions
        WHERE contact_id = ${contactId} AND audience_key = ${audienceKey}
      `.execute(trx)
      return result.rows[0] == null ? null : subscriptionFromRow(result.rows[0])
    },
    async getSubscriptionById(id) {
      const result = await sql<SubscriptionRow>`
        SELECT * FROM newsletter_subscriptions WHERE id = ${id}
      `.execute(trx)
      return result.rows[0] == null ? null : subscriptionFromRow(result.rows[0])
    },
    async createSubscription(input: CreateSubscriptionInput) {
      const result = await sql<SubscriptionRow>`
        INSERT INTO newsletter_subscriptions
          (id, lifecycle_generation, contact_id, audience_key, status,
           consent_version, consent_source, consent_locale, consented_at,
           confirmation_delivery_id, confirmation_attempt_id,
           confirmation_lease_expires_at, confirmation_sent_at, confirmed_at,
           unsubscribed_at, created_at, updated_at)
        VALUES (${input.id}, ${input.lifecycleGeneration}, ${input.contactId},
                ${input.audienceKey}, ${input.status}, ${input.consent.version},
                ${input.consent.source ?? null}, ${input.consent.locale ?? null},
                ${input.consent.consentedAt}, ${input.confirmationDelivery?.id ?? null},
                ${input.confirmationDelivery?.attemptId ?? null},
                ${input.confirmationDelivery?.leaseExpiresAt ?? null},
                ${input.confirmationSentAt ?? null}, ${input.confirmedAt ?? null},
                ${input.unsubscribedAt ?? null}, ${input.createdAt}, ${input.updatedAt})
        RETURNING *
      `.execute(trx)
      return subscriptionFromRow(required(result.rows, 'subscription'))
    },
    async updateSubscription(id: string, patch: SubscriptionPatch) {
      const fields: RawBuilder<unknown>[] = []
      if (patch.lifecycleGeneration !== undefined) {
        fields.push(sql`lifecycle_generation = ${patch.lifecycleGeneration}`)
      }
      if (patch.status !== undefined) fields.push(sql`status = ${patch.status}`)
      if (patch.consent !== undefined) fields.push(...consentFields(patch.consent))
      if (patch.confirmationDelivery !== undefined) {
        fields.push(...deliveryFields(patch.confirmationDelivery))
      }
      if (patch.confirmationSentAt !== undefined) {
        fields.push(sql`confirmation_sent_at = ${patch.confirmationSentAt}`)
      }
      if (patch.confirmedAt !== undefined) fields.push(sql`confirmed_at = ${patch.confirmedAt}`)
      if (patch.unsubscribedAt !== undefined) {
        fields.push(sql`unsubscribed_at = ${patch.unsubscribedAt}`)
      }
      if (patch.updatedAt !== undefined) fields.push(sql`updated_at = ${patch.updatedAt}`)
      if (fields.length === 0) throw new Error('Cannot update a subscription with an empty patch.')
      const result = await sql<SubscriptionRow>`
        UPDATE newsletter_subscriptions SET ${sql.join(fields)}
        WHERE id = ${id} RETURNING *
      `.execute(trx)
      return subscriptionFromRow(required(result.rows, 'subscription'))
    },
    async listSubscriptions(contactId) {
      const result = await sql<SubscriptionRow>`
        SELECT * FROM newsletter_subscriptions
        WHERE contact_id = ${contactId} ORDER BY created_at, id
      `.execute(trx)
      return result.rows.map(subscriptionFromRow)
    },
    async appendEvent(event) {
      await sql`
        INSERT INTO newsletter_events
          (id, contact_id, subscription_id, event_type, occurred_at, metadata)
        VALUES (${event.id}, ${event.contactId}, ${event.subscriptionId ?? null},
                ${event.type}, ${event.occurredAt}, ${json(event.metadata)})
      `.execute(trx)
    },
    async listEvents(contactId) {
      const result = await sql<EventRow>`
        SELECT * FROM newsletter_events
        WHERE contact_id = ${contactId} ORDER BY sequence
      `.execute(trx)
      return result.rows.map(eventFromRow)
    },
    confirmationTokens: new PostgresConfirmationTokenStore(trx)
  }
}

function isPgConflict(error: unknown): boolean {
  if (typeof error !== 'object' || error == null || !('code' in error)) return false
  return error.code === '23505' || error.code === '40001' || error.code === '40P01'
}

/** Uses the caller's pool; PostgreSQL SERIALIZABLE aborts competing stale transitions. */
export function postgresStorage<DB>(db: Kysely<DB>): NewsletterStorage {
  return {
    async transaction<T>(operation: (transaction: NewsletterStorageTransaction) => Promise<T>) {
      try {
        return await db.transaction().setIsolationLevel('serializable')
          .execute(trx => operation(transactionAdapter(trx)))
      } catch (error) {
        if (isPgConflict(error)) {
          throw new StorageConflictError('Conflicting newsletter transaction.', { cause: error })
        }
        throw error
      }
    }
  }
}

export interface EligibleSubscription {
  readonly contact: Contact
  readonly subscription: Subscription
}

/** Mirrors the core delivery rule without adding policy in the storage layer. */
export async function listEligibleSubscriptions<DB>(
  db: Kysely<DB>,
  audienceKey: string
): Promise<readonly EligibleSubscription[]> {
  const result = await sql<SubscriptionRow & {
    contact: ContactRow
  }>`
    SELECT s.*, row_to_json(c) AS contact
    FROM newsletter_subscriptions s
    JOIN newsletter_contacts c ON c.id = s.contact_id
    WHERE s.audience_key = ${audienceKey}
      AND c.status = 'ENABLED'
      AND s.status = 'ACTIVE'
      AND s.confirmed_at IS NOT NULL
      AND s.unsubscribed_at IS NULL
    ORDER BY s.created_at, s.id
  `.execute(db)
  return result.rows.map(row => ({
    contact: contactFromRow(row.contact),
    subscription: subscriptionFromRow(row)
  }))
}

export interface PostgresRateLimiter {
  readonly consume: RateLimiter['consume']
  cleanup(input?: { readonly now?: Date }): Promise<number>
}

/** Use a privacy-preserving key provider; the limiter never sees raw request context. */
export function postgresRateLimiter<DB>(
  db: Kysely<DB>,
  clock: { now(): Date } = { now: () => new Date() }
): PostgresRateLimiter {
  return {
    async consume(input: {
      readonly key: string
      readonly action: PublicAbuseAction
      readonly limit: number
      readonly windowMs: number
    }) {
      if (
        !Number.isSafeInteger(input.windowMs) || input.windowMs <= 0
        || !Number.isSafeInteger(input.limit) || input.limit <= 0
      ) {
        throw new Error('SQL rate-limit window and limit must be positive safe integers.')
      }
      const now = clock.now().getTime()
      const bucketStartMs = Math.floor(now / input.windowMs) * input.windowMs
      const expiresAt = bucketStartMs + input.windowMs
      if (!Number.isSafeInteger(expiresAt)) throw new Error('Invalid SQL rate-limit window.')
      const result = await sql<{ attempt_count: number }>`
        INSERT INTO newsletter_rate_limits
          (key_hash, action, window_ms, bucket_start_ms, expires_at, attempt_count)
        VALUES (${input.key}, ${input.action}, ${input.windowMs},
                ${bucketStartMs}, ${new Date(expiresAt)}, 1)
        ON CONFLICT (key_hash, action, window_ms, bucket_start_ms)
        DO UPDATE SET attempt_count = newsletter_rate_limits.attempt_count + 1
        RETURNING attempt_count
      `.execute(db)
      const allowed = required(result.rows, 'rate-limit bucket').attempt_count <= input.limit
      return allowed ? { allowed: true } : { allowed: false, retryAfterMs: expiresAt - now }
    },
    async cleanup(input = {}) {
      const result = await sql<{ key_hash: string }>`
        DELETE FROM newsletter_rate_limits
        WHERE expires_at <= ${input.now ?? clock.now()} RETURNING key_hash
      `.execute(db)
      return result.rows.length
    }
  }
}

export { postgresMigration } from './migration/postgres-provider.js'
export type { PostgresMigrationOptions } from './migration/postgres-provider.js'
