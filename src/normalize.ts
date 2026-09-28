import {
  NEWSLETTER_ERROR_CODES,
  NewsletterError
} from './errors.js'

export const DEFAULT_AUDIENCE_KEY = 'default'

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** Trims and lowercases an email address without validating its format. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

/**
 * Returns a trimmed, lowercase email address after basic format validation.
 * @throws {NewsletterError} If the address is empty, exceeds 254 characters,
 * or fails the basic email pattern.
 */
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

/**
 * Returns a trimmed audience key while preserving its case.
 * @throws {NewsletterError} If the trimmed key is outside 1–128 characters.
 */
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
