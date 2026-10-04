import type {
  ConsentEvidence,
  Contact,
  ExternalSubject,
  JsonValue,
  NewsletterEvent,
  Subscription,
  SubscriptionStatus
} from './domain.js'
import type { DeliveryFeedback } from './domain.js'
import type { ConfirmationReplacementStrategy } from './security.js'

export interface SubscribeInput {
  readonly email: string
  readonly audience?: string
  readonly consent: {
    readonly granted: boolean
    readonly version: string
    readonly source?: string | null
    readonly locale?: string | null
  }
  readonly subject?: ExternalSubject
  /** Host context for this subscribe operation; stored in SIGNED_UP/RESUBSCRIBED event metadata. */
  readonly metadata?: Readonly<Record<string, JsonValue>>
  readonly securityContext?: unknown
}

export interface ResendConfirmationInput {
  readonly email: string
  readonly audience?: string
  readonly securityContext?: unknown
}

export interface ConfirmInput {
  readonly token: string
}

export type ConfirmResult =
  | { readonly confirmed: true }
  | { readonly confirmed: false }

export interface UnsubscribeInput {
  readonly capability: string
}

export type UnsubscribeResult =
  | { readonly unsubscribed: true }
  | { readonly unsubscribed: false }

export interface CreateUnsubscribeCapabilityInput {
  readonly email: string
  readonly audience?: string
  readonly all?: boolean
}

export interface PreferenceSubscription {
  readonly audience: string
  readonly status: SubscriptionStatus
  readonly unsubscribeCapability: string
}

export interface CleanupConfirmationTokensInput {
  readonly retentionMs?: number
}

export type ContactLookup =
  | { readonly email: string; readonly id?: never }
  | { readonly id: string; readonly email?: never }

export interface ContactTokenMetadata {
  readonly purpose: 'CONFIRMATION'
  readonly subscriptionId: string
  readonly lifecycleGeneration: number
  readonly createdAt: Date
  readonly expiresAt: Date
  readonly consumedAt?: Date | null
  readonly revokedAt?: Date | null
}

export interface ContactDataExport {
  readonly contact: Contact
  readonly subscriptions: readonly Subscription[]
  readonly events: readonly NewsletterEvent[]
  readonly confirmationTokens: readonly ContactTokenMetadata[]
}

export interface EraseContactDataInput {
  readonly contact: ContactLookup
  readonly strategy: 'DELETE' | 'ANONYMIZE'
  /** Retain only an opaque, host-keyed suppression digest. Defaults to NONE. */
  readonly suppression?: 'NONE' | 'RETAIN_HASH'
}

export type SubscriptionLookup =
  | { readonly id: string; readonly email?: never; readonly audience?: never }
  | {
    readonly email: string
    readonly audience?: string
    readonly id?: never
  }

/** Trusted server-side history; the host must authorize access. */
export interface ListSubscriptionEventsInput {
  readonly subscription: SubscriptionLookup
  /** Defaults to 50; must be an integer between 1 and 100. */
  readonly limit?: number
  readonly cursor?: string
}

export interface SubscriptionEventsPage {
  readonly events: readonly NewsletterEvent[]
  readonly nextCursor: string | null
}

/** Trusted server-side lookup; the host must authorize access. */
export interface ConfirmationSubscriptionInput {
  readonly subscription: SubscriptionLookup
}

/** Trusted server-side creation; metadata is used only for the audit event. */
export interface CreateConfirmationTokenInput extends ConfirmationSubscriptionInput {
  /** Overrides confirmation.replacementStrategy for this trusted call only. */
  readonly replacementStrategy?: ConfirmationReplacementStrategy
  /** Host-specific JSON audit data; authoritative system metadata takes precedence. */
  readonly eventMetadata?: Readonly<Record<string, JsonValue>>
}

export interface CreateConfirmationTokenResult {
  readonly token: string
  readonly expiresAt: Date
}

export interface ConfirmationState {
  readonly canCreate: boolean
  /** Null when confirmation is allowed. */
  readonly reason: 'ACTIVE' | 'UNSUBSCRIBED' | 'SUPPRESSED' | null
  /** Latest expiry among usable tokens in the current lifecycle; null when ineligible. */
  readonly activeTokenExpiresAt: Date | null
}

export interface LinkSubjectInput {
  readonly email: string
  readonly subject: ExternalSubject
  readonly replace?: boolean
}

export interface SuppressContactInput {
  readonly email: string
  readonly reason: string
}

export interface UnsuppressContactInput {
  readonly email: string
}

export interface ImportSubscriptionInput {
  readonly email: string
  readonly audience?: string
  readonly status: SubscriptionStatus
  readonly consent: ConsentEvidence
  readonly confirmedAt?: Date | null
  readonly unsubscribedAt?: Date | null
  readonly subject?: ExternalSubject
  /** Initial Contact metadata when the import creates a new contact. */
  readonly metadata?: Readonly<Record<string, JsonValue>>
  readonly originalCreatedAt?: Date
}

export interface PublicRequestResult {
  readonly accepted: true
}

export interface NewsletterService {
  processFeedback(input: DeliveryFeedback): Promise<{ readonly processed: boolean; readonly suppressed: boolean }>
  subscribe(input: SubscribeInput): Promise<PublicRequestResult>
  resendConfirmation(
    input: ResendConfirmationInput
  ): Promise<PublicRequestResult>
  /** Trusted server-only operation. Returns null if missing or ineligible; never sends mail. */
  createConfirmationToken(input: CreateConfirmationTokenInput): Promise<CreateConfirmationTokenResult | null>
  /** Trusted server-only introspection. Returns null if the subscription does not exist. */
  getConfirmationState(input: ConfirmationSubscriptionInput): Promise<ConfirmationState | null>
  confirm(input: ConfirmInput): Promise<ConfirmResult>
  unsubscribe(input: UnsubscribeInput): Promise<UnsubscribeResult>
  unsubscribeAll(input: UnsubscribeInput): Promise<UnsubscribeResult>

  createUnsubscribeCapability(
    input: CreateUnsubscribeCapabilityInput
  ): Promise<string | null>
  createManagePreferencesCapability(input: ContactLookup): Promise<string | null>
  listPreferences(input: { readonly capability: string }): Promise<readonly PreferenceSubscription[] | null>

  cleanupConfirmationTokens(
    input?: CleanupConfirmationTokensInput
  ): Promise<number>

  getContact(input: ContactLookup): Promise<Contact | null>
  getSubscription(input: SubscriptionLookup): Promise<Subscription | null>
  listSubscriptions(input: ContactLookup): Promise<readonly Subscription[]>
  listEvents(input: ContactLookup): Promise<readonly NewsletterEvent[]>
  /** Trusted server-only history in newest-first append order, across all generations. */
  listSubscriptionEvents(input: ListSubscriptionEventsInput): Promise<SubscriptionEventsPage>
  /** Trusted server-side operation; never expose this through a public route. */
  exportContactData(input: ContactLookup): Promise<ContactDataExport | null>
  /** Trusted server-side operation, independent of public unsubscribe. */
  eraseContactData(input: EraseContactDataInput): Promise<{ readonly erased: boolean }>
  /** Trusted server-side removal of detached suppression keys after erasure. */
  removeRetainedSuppression(input: { readonly email: string }): Promise<{ readonly removed: boolean }>

  linkSubject(input: LinkSubjectInput): Promise<Contact | null>
  suppressContact(input: SuppressContactInput): Promise<Contact | null>
  unsuppressContact(input: UnsuppressContactInput): Promise<Contact | null>

  importSubscription(input: ImportSubscriptionInput): Promise<Subscription>
}
