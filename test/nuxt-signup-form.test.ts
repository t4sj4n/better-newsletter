import { describe, expect, it, vi } from 'vitest'
import { effectScope, reactive, ref, toRef } from 'vue'
import type { NewsletterClientSubscribeResult } from '../packages/better-newsletter/src/client.js'
import { useNewsletterSignup, type UseNewsletterSignupOptions } from '../packages/better-newsletter/src/nuxt/runtime/index.js'

vi.mock('nuxt/app', () => ({
  useRuntimeConfig: vi.fn(() => ({ public: { betterNewsletter: {} } })),
  useNuxtApp: vi.fn(() => ({}))
}))

function deferredAcceptance() {
  let resolve!: (value: NewsletterClientSubscribeResult) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<NewsletterClientSubscribeResult>((accept, fail) => {
    resolve = accept
    reject = fail
  })
  return { promise, accept: () => resolve({ accepted: true }), reject }
}

describe('signup external refs', () => {
  it('preserves supplied ref identity and initial values', () => {
    const email = ref('existing@example.com')
    const consent = ref(true)
    const signup = useNewsletterSignup({ email, consent })

    expect(signup.email).toBe(email)
    expect(signup.consent).toBe(consent)
    expect(signup.email.value).toBe('existing@example.com')
    expect(signup.consent.value).toBe(true)
    expect(signup.submitted.value).toBe(false)
    expect(signup.state.value).toBe('idle')
  })

  it('creates independent default refs for any omitted inputs', () => {
    const email = ref('existing@example.com')
    const consent = ref(true)
    const withEmail = useNewsletterSignup({ email })
    const withConsent = useNewsletterSignup({ consent })
    const defaults = useNewsletterSignup()

    expect(withEmail.email).toBe(email)
    expect(withEmail.consent.value).toBe(false)
    expect(withConsent.email.value).toBe('')
    expect(withConsent.consent).toBe(consent)
    expect(defaults.email.value).toBe('')
    expect(defaults.consent.value).toBe(false)
    defaults.email.value = 'another@example.com'
    defaults.consent.value = true
    expect(email.value).toBe('existing@example.com')
    expect(withEmail.consent.value).toBe(false)
  })

  it('binds reactive properties in both directions and reflects validation without resetting an error', async () => {
    const hostForm = reactive({ email: '', consent: false })
    const error = new Error('Server unavailable')
    const subscribe = vi.fn().mockRejectedValue(error)
    const signup = useNewsletterSignup({
      email: toRef(hostForm, 'email'), consent: toRef(hostForm, 'consent'), client: { subscribe }
    })

    await signup.submit()
    expect(signup.emailError.value).toBeDefined()
    expect(signup.consentError.value).toBeDefined()
    expect(subscribe).not.toHaveBeenCalled()

    hostForm.email = 'host@example.com'
    hostForm.consent = true
    expect(signup.emailError.value).toBeUndefined()
    expect(signup.consentError.value).toBeUndefined()
    expect(signup.state.value).toBe('idle')
    await signup.submit()
    expect(subscribe).toHaveBeenCalledExactlyOnceWith({
      email: 'host@example.com', consent: true, consentVersion: 'v1'
    })

    hostForm.email = 'invalid'
    hostForm.consent = false
    expect(signup.email.value).toBe('invalid')
    expect(signup.consent.value).toBe(false)
    expect(signup.emailError.value).toBeDefined()
    expect(signup.consentError.value).toBeDefined()
    expect(signup.state.value).toBe('error')
    expect(signup.error.value).toBe(error)

    signup.email.value = 'composable@example.com'
    signup.consent.value = true
    expect(hostForm).toEqual({ email: 'composable@example.com', consent: true })
    expect(signup.state.value).toBe('error')
    expect(signup.error.value).toBe(error)

    signup.reset()
    expect(hostForm).toEqual({ email: '', consent: false })
    expect(signup.submitted.value).toBe(false)
    expect(signup.emailError.value).toBeUndefined()
    expect(signup.consentError.value).toBeUndefined()
    expect(signup.state.value).toBe('idle')
    expect(signup.error.value).toBeUndefined()
  })
})

describe.each(['internal', 'external'] as const)('signup clearing with %s refs', binding => {
  function createForm(options: UseNewsletterSignupOptions = {}) {
    const signup = useNewsletterSignup({
      ...(binding === 'external' ? { email: ref('user@example.com'), consent: ref(true) } : {}),
      ...options
    })
    if (binding === 'internal') {
      signup.email.value = 'user@example.com'
      signup.consent.value = true
    }
    return signup
  }

  it.each(['success', 'error', 'loading'] as const)(
    'clearForm preserves the %s request state and raw error', async state => {
      const pending = deferredAcceptance()
      const error = new Error('Server unavailable')
      const signup = createForm({ client: { subscribe: vi.fn(() => pending.promise) } })
      const request = signup.submit()
      if (state === 'success') { pending.accept(); await request }
      if (state === 'error') { pending.reject(error); await request }

      expect(signup.submitted.value).toBe(true)
      signup.clearForm()
      expect(signup.email.value).toBe('')
      expect(signup.consent.value).toBe(false)
      expect(signup.submitted.value).toBe(false)
      expect(signup.emailError.value).toBeUndefined()
      expect(signup.consentError.value).toBeUndefined()
      expect(signup.state.value).toBe(state)
      expect(signup.error.value).toBe(state === 'error' ? error : undefined)

      if (state === 'loading') {
        pending.accept()
        expect(await request).toMatchObject({ state: 'success', failed: false })
      }
    }
  )

  it.each([undefined, false, true])('clearOnSuccess=%s retains or clears unchanged input', async clearOnSuccess => {
    const signup = createForm({
      ...(clearOnSuccess === undefined ? {} : { clearOnSuccess }),
      client: { subscribe: vi.fn().mockResolvedValue({ accepted: true }) }
    })
    expect(await signup.submit()).toMatchObject({ state: 'success', failed: false })
    expect(signup.email.value).toBe(clearOnSuccess ? '' : 'user@example.com')
    expect(signup.consent.value).toBe(!clearOnSuccess)
    expect(signup.submitted.value).toBe(!clearOnSuccess)
    expect(signup.state.value).toBe('success')
    expect(signup.error.value).toBeUndefined()
    expect(signup.emailError.value).toBeUndefined()
    expect(signup.consentError.value).toBeUndefined()
  })

  it('retains input and submitted validation after a failed request', async () => {
    const error = new Error('Server unavailable')
    const signup = createForm({ clearOnSuccess: true, client: { subscribe: vi.fn().mockRejectedValue(error) } })
    expect(await signup.submit()).toMatchObject({ state: 'error', error, failed: true })
    expect(signup.email.value).toBe('user@example.com')
    expect(signup.consent.value).toBe(true)
    expect(signup.submitted.value).toBe(true)
  })

  it('does not clear invalid input or send a request', async () => {
    const subscribe = vi.fn()
    const signup = createForm({ clearOnSuccess: true, client: { subscribe } })
    signup.email.value = 'invalid'
    expect(await signup.submit()).toBeUndefined()
    expect(subscribe).not.toHaveBeenCalled()
    expect(signup.email.value).toBe('invalid')
    expect(signup.submitted.value).toBe(true)
    expect(signup.emailError.value).toBeDefined()
    expect(signup.state.value).toBe('idle')
  })

  it.each(['email', 'consent', 'email restored', 'consent restored'] as const)(
    'preserves the form when %s is edited during a request', async edit => {
      const pending = deferredAcceptance()
      const signup = createForm({ clearOnSuccess: true, client: { subscribe: vi.fn(() => pending.promise) } })
      const request = signup.submit()
      if (edit.startsWith('email')) signup.email.value = 'new@example.com'
      else signup.consent.value = false
      if (edit === 'email restored') signup.email.value = 'user@example.com'
      if (edit === 'consent restored') signup.consent.value = true

      const editedEmail = signup.email.value
      const editedConsent = signup.consent.value
      expect(signup.state.value).toBe('loading')
      expect(signup.error.value).toBeUndefined()
      pending.accept()
      expect(await request).toMatchObject({ state: 'success', failed: false })
      expect(signup.email.value).toBe(editedEmail)
      expect(signup.consent.value).toBe(editedConsent)
      expect(signup.submitted.value).toBe(true)
    }
  )

  it.each(['idle', 'loading', 'success', 'error'] as const)(
    'ignores stale success after reset while the newer request state is %s', async state => {
      const first = deferredAcceptance()
      const second = deferredAcceptance()
      const subscribe = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
      const signup = createForm({ clearOnSuccess: true, client: { subscribe } })
      const oldRequest = signup.submit()
      signup.reset()
      signup.email.value = 'new@example.com'
      signup.consent.value = true

      const newRequest = state === 'idle' ? undefined : signup.submit()
      if (state === 'success') {
        second.accept()
        await newRequest
        signup.email.value = 'next@example.com'
        signup.consent.value = true
      }
      if (state === 'error') { second.reject(new Error('New request failed')); await newRequest }
      const currentEmail = signup.email.value
      const currentConsent = signup.consent.value
      const currentError = signup.error.value
      const currentSubmitted = signup.submitted.value

      first.accept()
      expect(await oldRequest).toBeUndefined()
      expect(signup.state.value).toBe(state)
      expect(signup.error.value).toBe(currentError)
      expect(signup.email.value).toBe(currentEmail)
      expect(signup.consent.value).toBe(currentConsent)
      expect(signup.submitted.value).toBe(currentSubmitted)

      if (state === 'loading') {
        second.accept()
        expect(await newRequest).toMatchObject({ state: 'success', failed: false })
        expect(signup.email.value).toBe('')
        expect(signup.consent.value).toBe(false)
      }
    }
  )

  it('keeps the active request eligible for clearing after a duplicate submit', async () => {
    const pending = deferredAcceptance()
    const subscribe = vi.fn(() => pending.promise)
    const signup = createForm({ clearOnSuccess: true, client: { subscribe } })
    const request = signup.submit()
    expect(await signup.submit()).toBeUndefined()
    expect(subscribe).toHaveBeenCalledTimes(1)
    pending.accept()
    await request
    expect(signup.state.value).toBe('success')
    expect(signup.email.value).toBe('')
    expect(signup.consent.value).toBe(false)
  })

  it('does not clear fields when the owning scope is disposed before success', async () => {
    const pending = deferredAcceptance()
    const scope = effectScope()
    const signup = scope.run(() => createForm({
      clearOnSuccess: true, client: { subscribe: vi.fn(() => pending.promise) }
    }))!
    const request = signup.submit()
    scope.stop()
    signup.email.value = 'new@example.com'
    pending.accept()
    expect(await request).toBeUndefined()
    expect(signup.email.value).toBe('new@example.com')
    expect(signup.consent.value).toBe(true)
    expect(signup.submitted.value).toBe(true)
    expect(signup.error.value).toBeUndefined()
  })
})
