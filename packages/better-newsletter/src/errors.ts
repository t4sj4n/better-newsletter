export const NEWSLETTER_ERROR_CODES = {
  INVALID_EMAIL: 'INVALID_EMAIL',
  INVALID_PAGINATION: 'INVALID_PAGINATION',
  INVALID_AUDIENCE: 'INVALID_AUDIENCE',
  CONSENT_REQUIRED: 'CONSENT_REQUIRED',
  INVALID_TOKEN: 'INVALID_TOKEN',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  ALREADY_CONFIRMED: 'ALREADY_CONFIRMED',
  RATE_LIMITED: 'RATE_LIMITED',
  ABUSE_REJECTED: 'ABUSE_REJECTED',
  SUPPRESSED: 'SUPPRESSED',
  SUBJECT_CONFLICT: 'SUBJECT_CONFLICT',
  IMPORT_CONFLICT: 'IMPORT_CONFLICT',
  INVALID_IMPORT: 'INVALID_IMPORT',
  INVALID_CONFIGURATION: 'INVALID_CONFIGURATION',
  INVALID_WEBHOOK: 'INVALID_WEBHOOK'
} as const

export type NewsletterErrorCode =
  typeof NEWSLETTER_ERROR_CODES[keyof typeof NEWSLETTER_ERROR_CODES]

export interface NewsletterErrorOptions {
  /** Present on `RATE_LIMITED` errors when the limiter reports a retry delay. */
  readonly retryAfterMs?: number
  readonly cause?: unknown
}

export class NewsletterError extends Error {
  readonly code: NewsletterErrorCode
  readonly retryAfterMs?: number

  constructor(
    code: NewsletterErrorCode,
    message: string,
    options: NewsletterErrorOptions = {}
  ) {
    super(
      message,
      options.cause !== undefined ? { cause: options.cause } : undefined
    )
    this.name = 'NewsletterError'
    this.code = code
    if (options.retryAfterMs !== undefined) {
      this.retryAfterMs = options.retryAfterMs
    }
  }
}

/**
 * Thrown by storage adapters when a transaction lost a concurrency conflict:
 * a unique-constraint violation, a serialization failure, or a deadlock.
 * The core rolls back and re-runs the whole transaction callback.
 */
export class StorageConflictError extends Error {
  constructor(message: string, options: { readonly cause?: unknown } = {}) {
    super(
      message,
      options.cause !== undefined ? { cause: options.cause } : undefined
    )
    this.name = 'StorageConflictError'
  }
}
