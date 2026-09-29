import type { Contact, Subscription } from './domain.js'

export interface ConfirmationMailInput {
  readonly contact: Contact
  readonly subscription: Subscription
  readonly token: string
  readonly expiresAt: Date
  /** Stable ID of the delivery work item across retries; use it for correlation. */
  readonly deliveryId: string
  /**
   * Unique ID of this claimed attempt. Every attempt carries a fresh token, so
   * use this, not `deliveryId`, as a provider idempotency key.
   */
  readonly attemptId: string
  readonly audienceKey: string
  readonly lifecycleGeneration: number
}

export const MAIL_DELIVERY_FAILURES = {
  /** Not sent; the claim is released so a later signup/resend retries at once. */
  TEMPORARY: 'TEMPORARY',
  /** Not sent and retrying the same work is pointless; the work item is dropped. */
  PERMANENT: 'PERMANENT',
  /**
   * The provider may have sent the message; the claim is held until its lease
   * expires so an immediate retry does not add another message.
   */
  AMBIGUOUS: 'AMBIGUOUS'
} as const

export type MailDeliveryFailure =
  typeof MAIL_DELIVERY_FAILURES[keyof typeof MAIL_DELIVERY_FAILURES]

export const MAIL_DELIVERY_REASONS = {
  INVALID_REQUEST: 'INVALID_REQUEST',
  AUTH_FAILED: 'AUTH_FAILED',
  RATE_LIMITED: 'RATE_LIMITED',
  PROVIDER_UNAVAILABLE: 'PROVIDER_UNAVAILABLE',
  TIMEOUT: 'TIMEOUT',
  RENDER_FAILED: 'RENDER_FAILED',
  TOKEN_SETUP_FAILED: 'TOKEN_SETUP_FAILED',
  UNKNOWN: 'UNKNOWN'
} as const

export type MailDeliveryReasonCode =
  typeof MAIL_DELIVERY_REASONS[keyof typeof MAIL_DELIVERY_REASONS]

/**
 * `accepted: false` without `failure` is treated as `TEMPORARY`. A mailer that
 * throws during delivery is treated as `AMBIGUOUS`, since the provider may
 * already have accepted the message. Reasons are bounded codes, not provider
 * error messages; the core validates them again before persisting evidence.
 */
export type MailDeliveryResult =
  | {
    readonly accepted: true
    readonly providerMessageId?: string
  }
  | {
    readonly accepted: false
    readonly failure?: MailDeliveryFailure
    readonly providerMessageId?: string
    readonly reason?: MailDeliveryReasonCode
  }

export interface NewsletterMailer {
  sendConfirmation(input: ConfirmationMailInput): Promise<MailDeliveryResult>
}
