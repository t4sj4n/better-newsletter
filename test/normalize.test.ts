import { describe, expect, it } from 'vitest'
import {
  assertAudienceKey,
  NEWSLETTER_ERROR_CODES,
  NewsletterError,
  normalizeAndValidateEmail,
  normalizeEmail
} from '../src/index.js'

describe('normalization', () => {
  it('normalizes e-mail consistently', () => {
    expect(normalizeEmail('  Person@Example.COM '))
      .toBe('person@example.com')
    expect(normalizeAndValidateEmail('  Person@Example.COM '))
      .toBe('person@example.com')
  })

  it('rejects malformed e-mail addresses with a typed error', () => {
    try {
      normalizeAndValidateEmail('not-an-email')
      throw new Error('Expected normalizeAndValidateEmail to throw.')
    } catch (error) {
      expect(error).toBeInstanceOf(NewsletterError)
      expect((error as NewsletterError).code)
        .toBe(NEWSLETTER_ERROR_CODES.INVALID_EMAIL)
    }
  })

  it('preserves opaque audience-key casing while trimming whitespace', () => {
    expect(assertAudienceKey('  Product-News '))
      .toBe('Product-News')
  })

  it('rejects empty audience keys with a typed error', () => {
    try {
      assertAudienceKey('   ')
      throw new Error('Expected assertAudienceKey to throw.')
    } catch (error) {
      expect(error).toBeInstanceOf(NewsletterError)
      expect((error as NewsletterError).code)
        .toBe(NEWSLETTER_ERROR_CODES.INVALID_AUDIENCE)
    }
  })
})
