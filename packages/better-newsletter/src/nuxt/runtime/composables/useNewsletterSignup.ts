import { computed, ref, toValue, watch, type ComputedRef, type MaybeRefOrGetter, type Ref } from 'vue'
import type { NewsletterClient, NewsletterClientSubscribeInput } from '../../../client.js'
import type { NewsletterCopy, NewsletterCopyOverrides } from '../copy.js'
import { useNewsletterClient } from './useNewsletterClient.js'
import { useNewsletterCopy } from './useNewsletterCopy.js'
import { extractErrorMessage, focusInvalid, useNewsletterRequest, validEmail, type NewsletterState } from '../utils/request.js'

export interface UseNewsletterSignupOptions {
  email?: Ref<string>
  consent?: Ref<boolean>
  clearOnSuccess?: boolean
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
  submittedEmail: ComputedRef<string | undefined>
  state: Ref<NewsletterState>
  error: Ref<unknown>
  errorMessage: ComputedRef<string | undefined>
  emailError: ComputedRef<string | undefined>
  consentError: ComputedRef<string | undefined>
  messages: ComputedRef<NewsletterCopy>
  submit: (formElement?: HTMLFormElement | null) => Promise<{ state: NewsletterState; error?: unknown; failed: boolean } | undefined>
  clearForm: () => void
  reset: () => void
}

export function useNewsletterSignup(options?: UseNewsletterSignupOptions): UseNewsletterSignupReturn {
  const messages = useNewsletterCopy(() => toValue(options?.copy))
  const defaultClient = useNewsletterClient()
  const { state, error, reset: resetRequest, run } = useNewsletterRequest()

  const email = options?.email ?? ref('')
  const consent = options?.consent ?? ref(false)
  const submitted = ref(false)
  const lastSubmittedEmail = ref<string>()
  const submittedEmail = computed(() => lastSubmittedEmail.value)
  let formRevision = 0

  watch([email, consent], () => { formRevision++ }, { flush: 'sync' })

  const emailError = computed(() => submitted.value && !validEmail(email.value) ? messages.value.validation.email : undefined)
  const consentError = computed(() => submitted.value && !consent.value ? messages.value.validation.consent : undefined)
  const errorMessage = computed(() => state.value === 'error'
    ? extractErrorMessage(error.value, messages.value.signup.error) : undefined)

  function clearForm() {
    email.value = ''
    consent.value = false
    submitted.value = false
  }

  function reset() {
    clearForm()
    resetRequest()
    lastSubmittedEmail.value = undefined
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

    const submittedRevision = formRevision
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
    return await run(() => client.subscribe(input), () => {
      // run invokes this mapper only for the active, undisposed request generation.
      lastSubmittedEmail.value = input.email
      if (options?.clearOnSuccess && formRevision === submittedRevision) clearForm()
      return 'success'
    })
  }

  return {
    email,
    consent,
    submitted,
    submittedEmail,
    state,
    error,
    errorMessage,
    emailError,
    consentError,
    messages,
    submit,
    clearForm,
    reset
  }
}
