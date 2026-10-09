import { computed, toValue, watch, type ComputedRef, type MaybeRefOrGetter, type Ref } from 'vue'
import { useRoute } from 'nuxt/app'
import type { NewsletterClient } from '../../../client.js'
import type { NewsletterCopy, NewsletterCopyOverrides } from '../copy.js'
import { useNewsletterClient } from './useNewsletterClient.js'
import { useNewsletterCopy } from './useNewsletterCopy.js'
import { useNewsletterRequest, type NewsletterState } from '../utils/request.js'

export interface UseNewsletterUnsubscribeOptions {
  token?: MaybeRefOrGetter<string | undefined>
  tokenQuery?: MaybeRefOrGetter<string | undefined>
  client?: MaybeRefOrGetter<Pick<NewsletterClient, 'unsubscribe'> | undefined>
  copy?: MaybeRefOrGetter<NewsletterCopyOverrides | undefined>
}

export interface UseNewsletterUnsubscribeReturn {
  token: ComputedRef<string>
  state: Ref<NewsletterState>
  loading: ComputedRef<boolean>
  displayState: ComputedRef<NewsletterState>
  error: Ref<unknown>
  resultTitle: ComputedRef<string>
  resultDescription: ComputedRef<string>
  messages: ComputedRef<NewsletterCopy>
  unsubscribe: () => Promise<{ state: NewsletterState; error?: unknown; failed: boolean } | undefined>
  reset: () => void
}

export function useNewsletterUnsubscribe(options?: UseNewsletterUnsubscribeOptions): UseNewsletterUnsubscribeReturn {
  const tokenQuery = computed(() => toValue(options?.tokenQuery) ?? 'capability')
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

  const resultTitle = computed(() => {
    switch (displayState.value) {
      case 'success': return messages.value.unsubscribe.successTitle
      case 'invalid': return messages.value.unsubscribe.invalidTitle
      default: return messages.value.common.error
    }
  })

  const resultDescription = computed(() => {
    switch (displayState.value) {
      case 'success': return messages.value.unsubscribe.success
      case 'invalid': return messages.value.unsubscribe.invalid
      default: return messages.value.unsubscribe.error
    }
  })

  watch(token, reset, { flush: 'sync' })

  async function unsubscribe() {
    if (!token.value || state.value === 'success' || state.value === 'loading') return
    const client = toValue(options?.client) ?? defaultClient
    return await run(
      () => client.unsubscribe(token.value),
      (value: { unsubscribed: boolean }) => value.unsubscribed ? 'success' : 'invalid'
    )
  }

  return {
    token,
    state,
    loading,
    displayState,
    error,
    resultTitle,
    resultDescription,
    messages,
    unsubscribe,
    reset
  }
}
