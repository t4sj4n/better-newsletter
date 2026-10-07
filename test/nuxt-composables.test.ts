import { describe, expect, it, vi } from 'vitest'

vi.mock('nuxt/app', () => ({
  useRoute: vi.fn(() => ({ query: {} })),
  useRuntimeConfig: vi.fn(() => ({ public: { betterNewsletter: {} } })),
  useNuxtApp: vi.fn(() => ({}))
}))

import {
  useNewsletterSignup,
  useNewsletterConfirm,
  useNewsletterResend,
  useNewsletterUnsubscribe,
  useNewsletterClient,
  useNewsletterCopy,
  validEmail,
  errorState,
  mergeNewsletterCopy,
  defaultNewsletterCopy
} from '../packages/better-newsletter/src/nuxt/runtime/index.js'

describe('validEmail', () => {
  it('validates well-formed email addresses', () => {
    expect(validEmail('test@example.com')).toBe(true)
    expect(validEmail('  test@example.com  ')).toBe(true)
    expect(validEmail('invalid')).toBe(false)
    expect(validEmail('@example.com')).toBe(false)
    expect(validEmail('test@')).toBe(false)
  })
})

describe('errorState', () => {
  it('maps custom error codes to states', () => {
    expect(errorState({ code: 'INVALID_TOKEN' })).toBe('invalid')
    expect(errorState({ code: 'TOKEN_EXPIRED' })).toBe('expired')
    expect(errorState({ code: 'ALREADY_CONFIRMED' })).toBe('alreadyConfirmed')
    expect(errorState({ code: 'OTHER' })).toBe('error')
    expect(errorState(new Error('generic'))).toBe('error')
    expect(errorState(null)).toBe('error')
  })
})

describe('mergeNewsletterCopy', () => {
  it('deep merges overrides with defaults', () => {
    const merged = mergeNewsletterCopy(defaultNewsletterCopy, {
      signup: {
        submit: 'Join Newsletter'
      }
    })
    expect(merged.signup.submit).toBe('Join Newsletter')
    expect(merged.signup.email).toBe(defaultNewsletterCopy.signup.email)
  })
})

describe('useNewsletterSignup', () => {
  it('manages state, validates email/consent, and delegates to client', async () => {
    const subscribe = vi.fn().mockResolvedValue({ accepted: true })
    const signup = useNewsletterSignup({ client: { subscribe } })

    expect(signup.state.value).toBe('idle')
    await signup.submit()
    expect(signup.emailError.value).toBeDefined()
    expect(signup.consentError.value).toBeDefined()
    expect(subscribe).not.toHaveBeenCalled()

    signup.email.value = 'user@example.com'
    signup.consent.value = true
    await signup.submit()

    expect(subscribe).toHaveBeenCalledWith({
      email: 'user@example.com',
      consent: true,
      consentVersion: 'v1'
    })
    expect(signup.state.value).toBe('success')
  })

  it('resets all form fields and state', () => {
    const signup = useNewsletterSignup()
    signup.email.value = 'user@example.com'
    signup.consent.value = true
    signup.submitted.value = true

    signup.reset()
    expect(signup.email.value).toBe('')
    expect(signup.consent.value).toBe(false)
    expect(signup.submitted.value).toBe(false)
    expect(signup.state.value).toBe('idle')
  })
})

describe('useNewsletterConfirm', () => {
  it('maps custom client error codes to states and guards against race conditions', async () => {
    const expiredError = Object.assign(new Error('Expired'), { code: 'TOKEN_EXPIRED' })
    const confirm = vi.fn().mockRejectedValue(expiredError)
    const confirmation = useNewsletterConfirm({
      token: 'test-token',
      client: { confirm, resendConfirmation: vi.fn() }
    })

    expect(confirmation.displayState.value).toBe('idle')
    await confirmation.confirm()
    expect(confirmation.displayState.value).toBe('expired')
    expect(confirmation.completed.value).toBe(false)
  })

  it('marks success when confirmed is true', async () => {
    const confirm = vi.fn().mockResolvedValue({ confirmed: true })
    const confirmation = useNewsletterConfirm({
      token: 'test-token',
      client: { confirm, resendConfirmation: vi.fn() }
    })

    await confirmation.confirm()
    expect(confirmation.displayState.value).toBe('success')
    expect(confirmation.completed.value).toBe(true)
  })
})

describe('useNewsletterResend', () => {
  it('validates email and calls resendConfirmation', async () => {
    const resendConfirmation = vi.fn().mockResolvedValue({ accepted: true })
    const resend = useNewsletterResend({ email: 'old@example.com', client: { resendConfirmation } })

    await resend.submit()
    expect(resendConfirmation).toHaveBeenCalledWith({ email: 'old@example.com' })
    expect(resend.state.value).toBe('success')
  })

  it('prevents submission when email is invalid', async () => {
    const resendConfirmation = vi.fn()
    const resend = useNewsletterResend({ email: 'not-an-email', client: { resendConfirmation } })

    await resend.submit()
    expect(resend.emailError.value).toBeDefined()
    expect(resendConfirmation).not.toHaveBeenCalled()
  })
})

describe('useNewsletterUnsubscribe', () => {
  it('handles token submission and success state', async () => {
    const unsubscribe = vi.fn().mockResolvedValue({ unsubscribed: true })
    const unsub = useNewsletterUnsubscribe({ token: 'test-cap', client: { unsubscribe } })

    await unsub.unsubscribe()
    expect(unsubscribe).toHaveBeenCalledWith('test-cap')
    expect(unsub.displayState.value).toBe('success')
  })

  it('maps false result to invalid', async () => {
    const unsubscribe = vi.fn().mockResolvedValue({ unsubscribed: false })
    const unsub = useNewsletterUnsubscribe({ token: 'test-cap', client: { unsubscribe } })

    await unsub.unsubscribe()
    expect(unsub.displayState.value).toBe('invalid')
  })
})

describe('useNewsletterClient', () => {
  it('creates client from nuxt runtime config', () => {
    const client = useNewsletterClient()
    expect(client).toBeDefined()
    expect(typeof client.subscribe).toBe('function')
    expect(typeof client.confirm).toBe('function')
    expect(typeof client.resendConfirmation).toBe('function')
    expect(typeof client.unsubscribe).toBe('function')
  })
})

describe('useNewsletterCopy', () => {
  it('returns default copy without overrides', () => {
    const copy = useNewsletterCopy()
    expect(copy.value.signup.submit).toBe(defaultNewsletterCopy.signup.submit)
  })

  it('applies reactive overrides', () => {
    const copy = useNewsletterCopy({
      signup: { submit: 'Custom Submit' }
    })
    expect(copy.value.signup.submit).toBe('Custom Submit')
    expect(copy.value.signup.email).toBe(defaultNewsletterCopy.signup.email)
  })
})

