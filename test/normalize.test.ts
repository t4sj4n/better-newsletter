import { describe, expect, it } from 'vitest'
import {
  assertAudienceKey,
  normalizeEmail
} from '../src/index.js'

describe('normalization', () => {
  it('normalizes e-mail consistently', () => {
    expect(normalizeEmail('  Person@Example.COM '))
      .toBe('person@example.com')
  })

  it('preserves opaque audience-key casing while trimming whitespace', () => {
    expect(assertAudienceKey('  Product-News '))
      .toBe('Product-News')
  })

  it('rejects empty audience keys', () => {
    expect(() => assertAudienceKey('   ')).toThrow(TypeError)
  })
})
