import { getCurrentScope, nextTick, onScopeDispose, ref } from 'vue'

export type NewsletterState = 'idle' | 'loading' | 'success' | 'error'
  | 'invalid' | 'expired' | 'alreadyConfirmed'

export function errorState(error: unknown): NewsletterState {
  if (typeof error !== 'object' || error === null || !('code' in error)) return 'error'
  switch ((error as Record<string, unknown>).code) {
    case 'INVALID_TOKEN': return 'invalid'
    case 'TOKEN_EXPIRED': return 'expired'
    case 'ALREADY_CONFIRMED': return 'alreadyConfirmed'
    default: return 'error'
  }
}

export function useNewsletterRequest() {
  const state = ref<NewsletterState>('idle')
  const error = ref<unknown>()
  let generation = 0

  function reset() {
    generation++
    state.value = 'idle'
    error.value = undefined
  }

  if (getCurrentScope()) {
    onScopeDispose(() => {
      generation++
    })
  }

  async function run<T>(
    action: () => Promise<T>,
    outcome: (result: T) => NewsletterState,
    failure: (error: unknown) => NewsletterState = () => 'error'
  ) {
    if (state.value === 'loading') return
    const current = ++generation
    let failed = false
    state.value = 'loading'
    error.value = undefined
    try {
      const result = await action()
      if (current === generation) state.value = outcome(result)
    } catch (cause) {
      failed = true
      if (current === generation) {
        error.value = cause
        state.value = failure(cause)
      }
    }
    if (current === generation) return { state: state.value, error: error.value, failed }
  }

  return { state, error, reset, run }
}

export async function focusInvalid(form: HTMLFormElement | null) {
  await nextTick()
  form?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus()
}

export function validEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())
}

