export const CONTACT_STATUSES = {
  ENABLED: 'ENABLED',
  SUPPRESSED: 'SUPPRESSED'
} as const

export type ContactStatus = typeof CONTACT_STATUSES[keyof typeof CONTACT_STATUSES]

export const SUBSCRIPTION_STATUSES = {
  PENDING_CONFIRMATION: 'PENDING_CONFIRMATION',
  ACTIVE: 'ACTIVE',
  UNSUBSCRIBED: 'UNSUBSCRIBED'
} as const

export type SubscriptionStatus =
  typeof SUBSCRIPTION_STATUSES[keyof typeof SUBSCRIPTION_STATUSES]

export const NEWSLETTER_EVENT_TYPES = {
  SIGNED_UP: 'SIGNED_UP',
  RESUBSCRIBED: 'RESUBSCRIBED',
  CONFIRMATION_REQUESTED: 'CONFIRMATION_REQUESTED',
  CONFIRMATION_SENT: 'CONFIRMATION_SENT',
  CONFIRMATION_SEND_FAILED: 'CONFIRMATION_SEND_FAILED',
  /** A provider result from an attempt that no longer owns the delivery work. */
  CONFIRMATION_STALE_RESULT: 'CONFIRMATION_STALE_RESULT',
  CONFIRMATION_REPLACED: 'CONFIRMATION_REPLACED',
  CONFIRMATION_EXPIRED: 'CONFIRMATION_EXPIRED',
  CONFIRMED: 'CONFIRMED',
  UNSUBSCRIBED: 'UNSUBSCRIBED',
  SUPPRESSED: 'SUPPRESSED',
  PROVIDER_FEEDBACK: 'PROVIDER_FEEDBACK',
  UNSUPPRESSED: 'UNSUPPRESSED',
  SUBJECT_LINKED: 'SUBJECT_LINKED',
  IMPORTED: 'IMPORTED'
} as const

export type NewsletterEventType =
  typeof NEWSLETTER_EVENT_TYPES[keyof typeof NEWSLETTER_EVENT_TYPES]

export const DELIVERY_FEEDBACK_TYPES = {
  SOFT_BOUNCE: 'SOFT_BOUNCE',
  HARD_BOUNCE: 'HARD_BOUNCE',
  COMPLAINT: 'COMPLAINT',
  PROVIDER_SUPPRESSION: 'PROVIDER_SUPPRESSION',
  DELIVERED: 'DELIVERED'
} as const

export type DeliveryFeedbackType = typeof DELIVERY_FEEDBACK_TYPES[keyof typeof DELIVERY_FEEDBACK_TYPES]

export interface DeliveryFeedback {
  readonly provider: string
  readonly providerEventId?: string
  readonly email: string
  readonly type: DeliveryFeedbackType
  readonly occurredAt: Date
}

export type JsonPrimitive = boolean | number | string | null
export type JsonValue =
  | JsonPrimitive
  | ReadonlyArray<JsonValue>
  | { readonly [key: string]: JsonValue }

export interface ExternalSubject {
  readonly namespace: string
  readonly id: string
}

export interface Contact {
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

export interface ConsentEvidence {
  readonly version: string
  readonly source?: string | null
  readonly locale?: string | null
  readonly consentedAt: Date
}

export interface Subscription {
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

export interface ConfirmationDelivery {
  readonly id: string
  readonly attemptId: string | null
  readonly leaseExpiresAt: Date | null
}

export interface NewsletterEvent {
  readonly id: string
  readonly contactId: string
  readonly subscriptionId?: string | null
  readonly type: NewsletterEventType
  readonly occurredAt: Date
  readonly metadata: Readonly<Record<string, JsonValue>>
}
