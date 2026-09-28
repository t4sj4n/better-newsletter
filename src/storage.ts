import type {
  ConsentEvidence,
  Contact,
  ContactStatus,
  ExternalSubject,
  JsonValue,
  NewsletterEvent,
  Subscription,
  SubscriptionStatus
} from './domain.js'

export interface CreateContactInput {
  readonly id: string
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
  | 'subject'
  | 'metadata'
  | 'suppressedAt'
  | 'suppressionReason'
  | 'updatedAt'
>>

export interface CreateSubscriptionInput {
  readonly id: string
  readonly contactId: string
  readonly audienceKey: string
  readonly status: SubscriptionStatus
  readonly consent: ConsentEvidence
  readonly confirmationSentAt?: Date | null
  readonly confirmedAt?: Date | null
  readonly unsubscribedAt?: Date | null
  readonly createdAt: Date
  readonly updatedAt: Date
}

export type SubscriptionPatch = Partial<Pick<
  Subscription,
  | 'status'
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
  listEvents(contactId: string): Promise<readonly NewsletterEvent[]>
}

/**
 * A production adapter must provide transaction semantics strong enough to
 * serialize conflicting Contact + audience lifecycle transitions. Database
 * adapters should enforce uniqueness independently as a second line of defense.
 */
export interface NewsletterStorage {
  transaction<T>(
    operation: (transaction: NewsletterStorageTransaction) => Promise<T>
  ): Promise<T>
}
