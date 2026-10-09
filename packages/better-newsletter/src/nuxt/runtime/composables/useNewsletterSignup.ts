import { computed, ref, toValue, type ComputedRef, type MaybeRefOrGetter, type Ref } from 'vue'
import type { NewsletterClient, NewsletterClientSubscribeInput } from '../../../client.js'
import type { NewsletterCopy, NewsletterCopyOverrides } from '../copy.js'
import { useNewsletterClient } from './useNewsletterClient.js'
import { useNewsletterCopy } from './useNewsletterCopy.js'
import { extractErrorMessage, focusInvalid, useNewsletterRequest, validEmail, type NewsletterState } from '../utils/request.js'

export interface UseNewsletterSignupOptions {
  audience?: MaybeRefOrGetter<string | undefined>
  source?: MaybeRefOrGetter<string | undefined>
  metadata?: MaybeRefOrGetter<NewsletterClientSubscribeInput['metadata']>
  consentVersion?: MaybeRefOrGetter<string | undefined>
  honeypot?: MaybeRefOrGetter<string | undefined>
  client?: MaybeRefOrGetter<Pick<NewsletterClient, 'subscribe'> | undefined>
  copy?: MaybeRefOrGetter<NewsletterCopyOverrides | undefined>
}

export interface UseNewsletterSignupReturn {
  email: Ref<string>
  consent: Ref<boolean>
  submitted: Ref<boolean>
  state: Ref<NewsletterState>
  error: Ref<unknown>
  errorMessage: ComputedRef<string | undefined>
  emailError: ComputedRef<string | undefined>
  consentError: ComputedRef<string | undefined>
  messages: ComputedRef<NewsletterCopy>
  submit: (formElement?: HTMLFormElement | null) => Promise<{ state: NewsletterState; error?: unknown; failed: boolean } | undefined>
  reset: () => void
}

export function useNewsletterSignup(options?: UseNewsletterSignupOptions): UseNewsletterSignupReturn {
  const messages = useNewsletterCopy(() => toValue(options?.copy))
  const defaultClient = useNewsletterClient()
  const { state, error, reset: resetRequest, run } = useNewsletterRequest()

  const email = ref('')
  const consent = ref(false)
  const submitted = ref(false)

  const emailError = computed(() => submitted.value && !validEmail(email.value) ? messages.value.validation.email : undefined)
  const consentError = computed(() => submitted.value && !consent.value ? messages.value.validation.consent : undefined)
  const errorMessage = computed(() => state.value === 'error'
    ? extractErrorMessage(error.value, messages.value.signup.error) : undefined)

  function reset() {
    email.value = ''
    consent.value = false
    submitted.value = false
    resetRequest()
  }

  async function submit(formElement?: HTMLFormElement | null) {
    if (state.value === 'loading') return
    submitted.value = true
    if (emailError.value || consentError.value) {
      if (formElement) {
        await focusInvalid(formElement)
      }
      return
    }

    const rawMetadata = toValue(options?.metadata)
    const source = toValue(options?.source)
    const metadata = { ...rawMetadata, ...(source === undefined ? {} : { source }) }

    const audience = toValue(options?.audience)
    const honeypot = toValue(options?.honeypot)?.trim()
    const input: NewsletterClientSubscribeInput = {
      email: email.value.trim(),
      consent: true,
      consentVersion: toValue(options?.consentVersion) ?? 'v1',
      ...(honeypot ? { website: honeypot } : {}),
      ...(audience !== undefined ? { audience } : {}),
      ...(Object.keys(metadata).length ? { metadata } : {})
    }

    const client = toValue(options?.client) ?? defaultClient
    return await run(() => client.subscribe(input), () => 'success')
  }

  return {
    email,
    consent,
    submitted,
    state,
    error,
    errorMessage,
    emailError,
    consentError,
    messages,
    submit,
    reset
  }
}
