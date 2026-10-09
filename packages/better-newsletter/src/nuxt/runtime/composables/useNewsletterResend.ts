import { computed, ref, toValue, watch, type ComputedRef, type MaybeRefOrGetter, type Ref } from 'vue'
import type { NewsletterClient } from '../../../client.js'
import type { NewsletterCopy, NewsletterCopyOverrides } from '../copy.js'
import { useNewsletterClient } from './useNewsletterClient.js'
import { useNewsletterCopy } from './useNewsletterCopy.js'
import { extractErrorMessage, focusInvalid, useNewsletterRequest, validEmail, type NewsletterState } from '../utils/request.js'

export interface UseNewsletterResendOptions {
  email?: MaybeRefOrGetter<string | undefined>
  audience?: MaybeRefOrGetter<string | undefined>
  client?: MaybeRefOrGetter<Pick<NewsletterClient, 'resendConfirmation'> | undefined>
  copy?: MaybeRefOrGetter<NewsletterCopyOverrides | undefined>
}

export interface UseNewsletterResendReturn {
  email: Ref<string>
  submitted: Ref<boolean>
  state: Ref<NewsletterState>
  loading: ComputedRef<boolean>
  error: Ref<unknown>
  errorMessage: ComputedRef<string | undefined>
  emailError: ComputedRef<string | undefined>
  messages: ComputedRef<NewsletterCopy>
  submit: (formElement?: HTMLFormElement | null) => Promise<{ state: NewsletterState; error?: unknown; failed: boolean } | undefined>
  reset: () => void
}

export function useNewsletterResend(options?: UseNewsletterResendOptions): UseNewsletterResendReturn {
  const messages = useNewsletterCopy(() => toValue(options?.copy))
  const defaultClient = useNewsletterClient()
  const { state, loading, error, reset: resetRequest, run } = useNewsletterRequest()

  const initialEmail = toValue(options?.email) ?? ''
  const email = ref(initialEmail)
  const submitted = ref(false)

  const emailError = computed(() => submitted.value && !validEmail(email.value) ? messages.value.validation.email : undefined)
  const errorMessage = computed(() => state.value === 'error'
    ? extractErrorMessage(error.value, messages.value.resend.error) : undefined)

  watch(() => toValue(options?.email), (value: string | undefined) => {
    email.value = value ?? ''
    submitted.value = false
    resetRequest()
  })

  function reset() {
    email.value = toValue(options?.email) ?? ''
    submitted.value = false
    resetRequest()
  }

  async function submit(formElement?: HTMLFormElement | null) {
    if (state.value === 'loading') return
    submitted.value = true
    if (emailError.value) {
      if (formElement) {
        await focusInvalid(formElement)
      }
      return
    }

    const client = toValue(options?.client) ?? defaultClient
    const audience = toValue(options?.audience)
    return await run(() => client.resendConfirmation({
      email: email.value.trim(),
      ...(audience !== undefined ? { audience } : {})
    }), () => 'success')
  }

  return {
    email,
    submitted,
    state,
    loading,
    error,
    errorMessage,
    emailError,
    messages,
    submit,
    reset
  }
}
