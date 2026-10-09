import { computed, toValue, watch, type ComputedRef, type MaybeRefOrGetter, type Ref } from 'vue'
import { useRoute } from 'nuxt/app'
import type { NewsletterClient } from '../../../client.js'
import type { NewsletterCopy, NewsletterCopyOverrides } from '../copy.js'
import { useNewsletterClient } from './useNewsletterClient.js'
import { useNewsletterCopy } from './useNewsletterCopy.js'
import { errorState, useNewsletterRequest, type NewsletterState } from '../utils/request.js'

export interface UseNewsletterConfirmOptions {
  token?: MaybeRefOrGetter<string | undefined>
  tokenQuery?: MaybeRefOrGetter<string | undefined>
  audience?: MaybeRefOrGetter<string | undefined>
  client?: MaybeRefOrGetter<Pick<NewsletterClient, 'confirm' | 'resendConfirmation'> | undefined>
  copy?: MaybeRefOrGetter<NewsletterCopyOverrides | undefined>
}

export interface UseNewsletterConfirmReturn {
  token: ComputedRef<string>
  state: Ref<NewsletterState>
  loading: ComputedRef<boolean>
  displayState: ComputedRef<NewsletterState>
  error: Ref<unknown>
  completed: ComputedRef<boolean>
  resultTitle: ComputedRef<string>
  resultDescription: ComputedRef<string>
  messages: ComputedRef<NewsletterCopy>
  confirm: () => Promise<{ state: NewsletterState; error?: unknown; failed: boolean } | undefined>
  reset: () => void
}

export function useNewsletterConfirm(options?: UseNewsletterConfirmOptions): UseNewsletterConfirmReturn {
  const tokenQuery = computed(() => toValue(options?.tokenQuery) ?? 'token')
  const messages = useNewsletterCopy(() => toValue(options?.copy))
  const route = useRoute()
  const defaultClient = useNewsletterClient()
  const { state, loading, error, reset, run } = useNewsletterRequest()

  const queryToken = computed(() => {
    const query = route?.query as Record<string, string | string[] | undefined> | undefined
    return query?.[tokenQuery.value]
  })
  const token = computed(() => {
    const explicit = toValue(options?.token)
    if (explicit !== undefined) return explicit
    const fromQuery = queryToken.value
    return typeof fromQuery === 'string' ? fromQuery : ''
  })

  const displayState = computed(() => token.value ? state.value : 'invalid')
  const completed = computed(() => displayState.value === 'success' || displayState.value === 'alreadyConfirmed')

  const resultTitle = computed(() => {
    switch (displayState.value) {
      case 'success': return messages.value.confirmation.successTitle
      case 'alreadyConfirmed': return messages.value.confirmation.alreadyConfirmedTitle
      case 'expired': return messages.value.confirmation.expiredTitle
      case 'invalid': return messages.value.confirmation.invalidTitle
      default: return messages.value.common.error
    }
  })

  const resultDescription = computed(() => {
    switch (displayState.value) {
      case 'success': return messages.value.confirmation.success
      case 'alreadyConfirmed': return messages.value.confirmation.alreadyConfirmed
      case 'expired': return messages.value.confirmation.expired
      case 'invalid': return messages.value.confirmation.invalid
      default: return messages.value.confirmation.error
    }
  })

  watch(token, reset, { flush: 'sync' })

  async function confirm() {
    if (!token.value || completed.value || state.value === 'loading') return
    const client = toValue(options?.client) ?? defaultClient
    return await run(
      () => client.confirm(token.value),
      (value: { confirmed: boolean }) => value.confirmed ? 'success' : 'invalid',
      errorState
    )
  }

  return {
    token,
    state,
    loading,
    displayState,
    error,
    completed,
    resultTitle,
    resultDescription,
    messages,
    confirm,
    reset
  }
}
