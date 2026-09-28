import {
  NEWSLETTER_ERROR_CODES,
  NewsletterError
} from './errors.js'

export const DEFAULT_AUDIENCE_KEY = 'default'

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

export function normalizeAndValidateEmail(email: string): string {
  const normalized = normalizeEmail(email)

  if (
    normalized.length === 0
    || normalized.length > 254
    || !EMAIL_PATTERN.test(normalized)
  ) {
    throw new NewsletterError(
      NEWSLETTER_ERROR_CODES.INVALID_EMAIL,
      'A valid e-mail address is required.'
    )
  }

  return normalized
}

export function assertAudienceKey(audienceKey: string): string {
  const normalized = audienceKey.trim()

  if (normalized.length === 0 || normalized.length > 128) {
    throw new NewsletterError(
      NEWSLETTER_ERROR_CODES.INVALID_AUDIENCE,
      'Audience key must contain between 1 and 128 characters.'
    )
  }

  return normalized
}
