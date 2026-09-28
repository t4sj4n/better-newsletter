import type {
  ConsentEvidence,
  ConfirmationDelivery,
  Contact,
  ContactStatus,
  ExternalSubject,
  JsonValue,
  NewsletterEvent,
  Subscription,
  SubscriptionStatus
} from './domain.js'
import type { ConfirmationTokenStore } from './security.js'

export interface CreateContactInput {
  readonly id: string
  readonly capabilityGeneration: number
  readonly email: string
  readonly status: ContactStatus
  readonly subject: ExternalSubject | null
  readonly metadata?: Readonly<Record<string, JsonValue>>
  readonly suppressedAt?: Date | null
  readonly suppressionReason?: string | null
  readonly createdAt: Date
  readonly updatedAt: Date
}

export type ContactPatch = Partial<Pick<
  Contact,
  | 'status'
  | 'capabilityGeneration'
  | 'subject'
  | 'metadata'
  | 'suppressedAt'
  | 'suppressionReason'
  | 'updatedAt'
>>

export interface CreateSubscriptionInput {
  readonly id: string
  readonly lifecycleGeneration: number
  readonly contactId: string
  readonly audienceKey: string
  readonly status: SubscriptionStatus
  readonly consent: ConsentEvidence
  readonly confirmationDelivery: ConfirmationDelivery | null
  readonly confirmationSentAt?: Date | null
  readonly confirmedAt?: Date | null
  readonly unsubscribedAt?: Date | null
  readonly createdAt: Date
  readonly updatedAt: Date
}

export type SubscriptionPatch = Partial<Pick<
  Subscription,
  | 'status'
  | 'lifecycleGeneration'
  | 'confirmationDelivery'
  | 'consent'
  | 'confirmationSentAt'
  | 'confirmedAt'
  | 'unsubscribedAt'
  | 'updatedAt'
>>

export interface NewsletterStorageTransaction {
  getContactByEmail(email: string): Promise<Contact | null>
  getContactById(id: string): Promise<Contact | null>
  createContact(input: CreateContactInput): Promise<Contact>
  updateContact(id: string, patch: ContactPatch): Promise<Contact>

  getSubscription(
    contactId: string,
    audienceKey: string
  ): Promise<Subscription | null>
  getSubscriptionById(id: string): Promise<Subscription | null>
  createSubscription(input: CreateSubscriptionInput): Promise<Subscription>
  updateSubscription(
    id: string,
    patch: SubscriptionPatch
  ): Promise<Subscription>
  listSubscriptions(contactId: string): Promise<readonly Subscription[]>

  appendEvent(event: NewsletterEvent): Promise<void>
  /** Returns events in append order, including events sharing a timestamp. */
  listEvents(contactId: string): Promise<readonly NewsletterEvent[]>

  /**
   * Confirmation-token records bound to this transaction. Token replacement,
   * consumption and revocation commit or roll back with lifecycle state.
   */
  readonly confirmationTokens: ConfirmationTokenStore
}

/**
 * Transaction contract for production adapters:
 *
 * - Conflicting contact-wide and subscription transitions must be serialized,
 *   including generation checks, delivery claims, token-store writes and
 *   event appends. Use SERIALIZABLE isolation, or lock every contact and
 *   subscription row read inside the transaction (e.g. `SELECT ... FOR UPDATE`).
 * - The core reads rows in a fixed order: contact before subscriptions before
 *   locking confirmation-token writes. `confirmationTokens.resolve()` is a
 *   non-locking read, so row-locking adapters keep a deadlock-free order.
 * - Unique-constraint violations, serialization failures and deadlocks must be
 *   thrown as `StorageConflictError`. The core then re-runs the whole callback,
 *   so a concurrent first signup observes the contact the other one created.
 * - Callbacks are retry-safe: they have no side effects outside the
 *   transaction. Adapters must not retry by themselves after a partial commit.
 * - State, token records and events commit or roll back together.
 */
export interface NewsletterStorage {
  transaction<T>(
    operation: (transaction: NewsletterStorageTransaction) => Promise<T>
  ): Promise<T>
}
