export const NEWSLETTER_ERROR_CODES = {
  INVALID_EMAIL: 'INVALID_EMAIL',
  INVALID_AUDIENCE: 'INVALID_AUDIENCE',
  CONSENT_REQUIRED: 'CONSENT_REQUIRED',
  INVALID_TOKEN: 'INVALID_TOKEN',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  ALREADY_CONFIRMED: 'ALREADY_CONFIRMED',
  RATE_LIMITED: 'RATE_LIMITED',
  SUPPRESSED: 'SUPPRESSED',
  SUBJECT_CONFLICT: 'SUBJECT_CONFLICT',
  INVALID_CONFIGURATION: 'INVALID_CONFIGURATION'
} as const

export type NewsletterErrorCode =
  typeof NEWSLETTER_ERROR_CODES[keyof typeof NEWSLETTER_ERROR_CODES]

export class NewsletterError extends Error {
  readonly code: NewsletterErrorCode

  constructor(code: NewsletterErrorCode, message: string) {
    super(message)
    this.name = 'NewsletterError'
    this.code = code
  }
}
