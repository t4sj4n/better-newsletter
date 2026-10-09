import { describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { createNewsletterClient, type NewsletterClient } from '../packages/better-newsletter/src/client.js'
import { extractErrorMessage } from '../packages/better-newsletter/src/nuxt/runtime/utils/request.js'
import type {
  NewsletterCopyOverrides, NewsletterState, UseNewsletterSignupReturn, UseNewsletterResendReturn
} from '../packages/better-newsletter/src/nuxt/runtime/index.js'

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

describe('extractErrorMessage', () => {
  it.each([
    [{ data: { statusMessage: ' Status ', message: 'Data' }, message: 'Error' }, 'Status'],
    [{ data: { statusMessage: '  ', message: ' Data ' }, message: 'Error' }, 'Data'],
    [{ data: { statusMessage: 42, message: false }, message: ' Error ' }, 'Error'],
    [{ data: { statusMessage: null, message: ['invalid'] } }, 'Fallback'],
    [{ data: null, message: 'Error' }, 'Error'],
    [{ data: 'invalid', message: 'Error' }, 'Error'],
    [{ data: [], message: 'Error' }, 'Error'],
    [{ message: ' ' }, 'Fallback'],
    [{ message: 42 }, 'Fallback'],
    [new Error('Newsletter request failed (429).'), 'Fallback'],
    [new Error('Newsletter request failed (0).'), 'Fallback'],
    [new Error('Newsletter request failed for another reason.'), 'Newsletter request failed for another reason.'],
    [new Error('Context: Newsletter request failed (400).'), 'Context: Newsletter request failed (400).'],
    [null, 'Fallback'],
    [undefined, 'Fallback'],
    ['raw string', 'Fallback'],
    [42, 'Fallback']
  ])('extracts a usable message from %j', (error, expected) => {
    expect(extractErrorMessage(error, 'Fallback')).toBe(expected)
  })

  it('returns undefined for an empty fallback and unusable error', () => {
    expect(extractErrorMessage({}, '  ')).toBeUndefined()
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
  it.each([
    [undefined, undefined], ['', undefined], ['  ', undefined], ['  bot  ', 'bot']
  ])('forwards only populated honeypots: %j', async (honeypot, expected) => {
    const subscribe = vi.fn().mockResolvedValue({ accepted: true })
    const signup = useNewsletterSignup({ honeypot, client: { subscribe } })
    signup.email.value = 'user@example.com'
    signup.consent.value = true

    expect(await signup.submit()).toMatchObject({ state: 'success', failed: false })
    const input = subscribe.mock.calls[0]?.[0]
    if (expected) expect(input).toHaveProperty('website', expected)
    else expect(input).not.toHaveProperty('website')
    expect(subscribe).toHaveBeenCalledTimes(1)
  })

  it.each(['ref', 'getter'] as const)('reads the current honeypot from a %s on each submit', async source => {
    const honeypot = ref<string>()
    const subscribe = vi.fn().mockResolvedValue({ accepted: true })
    const signup = useNewsletterSignup({
      honeypot: source === 'ref' ? honeypot : () => honeypot.value,
      client: { subscribe }
    })
    signup.email.value = 'user@example.com'
    signup.consent.value = true
    await signup.submit()
    expect(subscribe.mock.calls[0]?.[0]).not.toHaveProperty('website')
    honeypot.value = ' bot '
    await signup.submit()
    expect(subscribe.mock.calls[1]?.[0]).toHaveProperty('website', 'bot')
  })

  it('keeps validation active when a honeypot is populated', async () => {
    const subscribe = vi.fn()
    const signup = useNewsletterSignup({ honeypot: 'bot', client: { subscribe } })
    await signup.submit()
    expect(subscribe).not.toHaveBeenCalled()
    expect(signup.state.value).toBe('idle')
    expect(signup.emailError.value).toBeDefined()
    expect(signup.consentError.value).toBeDefined()
  })

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

describe.each(['signup', 'resend'] as const)('%s errorMessage', kind => {
  function createForm(
    client: Pick<NewsletterClient, 'subscribe' | 'resendConfirmation'>,
    copy = ref<NewsletterCopyOverrides>({})
  ): UseNewsletterSignupReturn | UseNewsletterResendReturn {
    if (kind === 'signup') {
      const form = useNewsletterSignup({ client, copy })
      form.email.value = 'user@example.com'
      form.consent.value = true
      return form
    }
    return useNewsletterResend({ email: 'user@example.com', client, copy })
  }

  it('shows structured default-client errors and clears them during a retry', async () => {
    let finishRetry!: (response: Response) => void
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ statusMessage: 'Please try again later' }), { status: 429 }))
      .mockImplementationOnce(() => new Promise<Response>(resolve => { finishRetry = resolve }))
    const client = createNewsletterClient(undefined, fetcher)
    const form = createForm(client)

    expect(form.errorMessage.value).toBeUndefined()
    await form.submit()
    expect(form.errorMessage.value).toBe('Please try again later')
    expect(form.error.value).toBeInstanceOf(Error)

    const retry = form.submit()
    expect(form.state.value).toBe('loading')
    expect(form.errorMessage.value).toBeUndefined()
    expect(form.error.value).toBeUndefined()
    finishRetry(new Response('{"accepted":true}'))
    expect(await retry).toMatchObject({ state: 'success', failed: false })
    expect(form.errorMessage.value).toBeUndefined()
  })

  it('reactively updates fallback copy and resets before resubmission', async () => {
    const copy = ref<NewsletterCopyOverrides>({})
    const action = vi.fn<() => Promise<{ accepted: true }>>()
      .mockRejectedValueOnce(new Error('Newsletter request failed (500).'))
      .mockResolvedValueOnce({ accepted: true })
    const form = createForm({ subscribe: action, resendConfirmation: action }, copy)
    await form.submit()
    expect(form.errorMessage.value).toBe(defaultNewsletterCopy[kind].error)
    copy.value = { [kind]: { error: 'Custom fallback' } }
    expect(form.errorMessage.value).toBe('Custom fallback')

    form.reset()
    expect(form.email.value).toBe(kind === 'signup' ? '' : 'user@example.com')
    expect(form.submitted.value).toBe(false)
    expect(form.state.value).toBe('idle')
    expect(form.error.value).toBeUndefined()
    expect(form.errorMessage.value).toBeUndefined()
    if ('consent' in form) expect(form.consent.value).toBe(false)

    form.email.value = 'retry@example.com'
    if ('consent' in form) form.consent.value = true
    await form.submit()
    expect(form.state.value).toBe('success')
    expect(form.errorMessage.value).toBeUndefined()
    expect(action).toHaveBeenCalledTimes(2)
  })
})

describe('useNewsletterConfirm', () => {
  it.each<NewsletterState>([
    'idle', 'loading', 'success', 'error', 'invalid', 'expired', 'alreadyConfirmed'
  ])('describes the %s display state and follows reactive copy', state => {
    const copy = ref<NewsletterCopyOverrides>({})
    const confirmation = useNewsletterConfirm({ token: 'token', copy })
    confirmation.state.value = state
    const field = state === 'success' || state === 'alreadyConfirmed' || state === 'expired' || state === 'invalid'
      ? state : 'error'
    expect(confirmation.resultDescription.value).toBe(defaultNewsletterCopy.confirmation[field])
    copy.value = { confirmation: { [field]: 'Updated description' } }
    expect(confirmation.resultDescription.value).toBe('Updated description')
  })

  it('describes missing tokens using displayState rather than request state', () => {
    const confirmation = useNewsletterConfirm({ token: '' })
    expect(confirmation.state.value).toBe('idle')
    expect(confirmation.resultDescription.value).toBe(defaultNewsletterCopy.confirmation.invalid)
  })

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
    expect(confirmation.resultTitle.value).toBe(defaultNewsletterCopy.confirmation.expiredTitle)
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
    expect(confirmation.resultTitle.value).toBe(defaultNewsletterCopy.confirmation.successTitle)
    expect(confirmation.completed.value).toBe(true)
  })

  it('falls back to common.error for error states', async () => {
    const confirm = vi.fn().mockRejectedValue(new Error('Unknown'))
    const confirmation = useNewsletterConfirm({
      token: 'test-token',
      client: { confirm, resendConfirmation: vi.fn() }
    })

    await confirmation.confirm()
    expect(confirmation.displayState.value).toBe('error')
    expect(confirmation.resultTitle.value).toBe(defaultNewsletterCopy.common.error)
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
  it.each<NewsletterState>([
    'idle', 'loading', 'success', 'error', 'invalid', 'expired', 'alreadyConfirmed'
  ])('describes the %s display state and follows reactive copy', state => {
    const copy = ref<NewsletterCopyOverrides>({})
    const unsub = useNewsletterUnsubscribe({ token: 'capability', copy })
    unsub.state.value = state
    const field = state === 'success' || state === 'invalid' ? state : 'error'
    expect(unsub.resultDescription.value).toBe(defaultNewsletterCopy.unsubscribe[field])
    copy.value = { unsubscribe: { [field]: 'Updated description' } }
    expect(unsub.resultDescription.value).toBe('Updated description')
  })

  it('describes missing tokens using displayState rather than request state', () => {
    const unsub = useNewsletterUnsubscribe({ token: '' })
    expect(unsub.state.value).toBe('idle')
    expect(unsub.resultDescription.value).toBe(defaultNewsletterCopy.unsubscribe.invalid)
  })

  it('handles token submission and success state', async () => {
    const unsubscribe = vi.fn().mockResolvedValue({ unsubscribed: true })
    const unsub = useNewsletterUnsubscribe({ token: 'test-cap', client: { unsubscribe } })

    await unsub.unsubscribe()
    expect(unsubscribe).toHaveBeenCalledWith('test-cap')
    expect(unsub.displayState.value).toBe('success')
    expect(unsub.resultTitle.value).toBe(defaultNewsletterCopy.unsubscribe.successTitle)
  })

  it('maps false result to invalid', async () => {
    const unsubscribe = vi.fn().mockResolvedValue({ unsubscribed: false })
    const unsub = useNewsletterUnsubscribe({ token: 'test-cap', client: { unsubscribe } })

    await unsub.unsubscribe()
    expect(unsub.displayState.value).toBe('invalid')
    expect(unsub.resultTitle.value).toBe(defaultNewsletterCopy.unsubscribe.invalidTitle)
  })

  it('falls back to common.error for error states', async () => {
    const unsubscribe = vi.fn().mockRejectedValue(new Error('Unknown'))
    const unsub = useNewsletterUnsubscribe({ token: 'test-cap', client: { unsubscribe } })

    await unsub.unsubscribe()
    expect(unsub.displayState.value).toBe('error')
    expect(unsub.resultTitle.value).toBe(defaultNewsletterCopy.common.error)
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
