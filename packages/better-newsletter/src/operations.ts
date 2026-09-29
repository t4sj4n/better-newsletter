import type {
  ConsentEvidence,
  Contact,
  ExternalSubject,
  JsonValue,
  NewsletterEvent,
  Subscription,
  SubscriptionStatus
} from './domain.js'

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

export type SubscriptionLookup =
  | { readonly id: string; readonly email?: never; readonly audience?: never }
  | {
    readonly email: string
    readonly audience?: string
    readonly id?: never
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
  readonly metadata?: Readonly<Record<string, JsonValue>>
  readonly originalCreatedAt?: Date
}

export interface PublicRequestResult {
  readonly accepted: true
}

export interface NewsletterService {
  subscribe(input: SubscribeInput): Promise<PublicRequestResult>
  resendConfirmation(
    input: ResendConfirmationInput
  ): Promise<PublicRequestResult>
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

  linkSubject(input: LinkSubjectInput): Promise<Contact | null>
  suppressContact(input: SuppressContactInput): Promise<Contact | null>
  unsuppressContact(input: UnsuppressContactInput): Promise<Contact | null>

  importSubscription(input: ImportSubscriptionInput): Promise<Subscription>
}
