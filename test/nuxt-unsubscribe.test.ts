import { afterEach, describe, expect, it, vi } from 'vitest'
import { effectScope, ref } from 'vue'
import { createNewsletterClient, type NewsletterClientUnsubscribeResult } from '../packages/better-newsletter/src/client.js'
import { betterNewsletter, SUBSCRIPTION_STATUSES } from '../packages/better-newsletter/src/index.js'
import { memoryAdapter, memoryCapabilities } from '../packages/better-newsletter/src/adapters/memory.js'
import { useNewsletterUnsubscribe } from '../packages/better-newsletter/src/nuxt/runtime/index.js'

vi.mock('nuxt/app', () => ({
  useRoute: vi.fn(() => ({ query: {} })),
  useRuntimeConfig: vi.fn(() => ({ public: { betterNewsletter: {} } })),
  useNuxtApp: vi.fn(() => ({}))
}))

afterEach(() => vi.unstubAllGlobals())

function deferredResult() {
  let resolve!: (result: NewsletterClientUnsubscribeResult) => void
  const promise = new Promise<NewsletterClientUnsubscribeResult>(accept => { resolve = accept })
  return { promise, accept: () => resolve({ unsubscribed: true }) }
}

describe('unsubscribe mode dispatch', () => {
  it.each([undefined, 'single', 'all'] as const)('uses the default browser client for mode=%s on explicit action only', async mode => {
    const fetcher = vi.fn().mockResolvedValue(new Response('{"unsubscribed":true}'))
    vi.stubGlobal('fetch', fetcher)
    const unsub = useNewsletterUnsubscribe({ ...(mode ? { mode } : {}), token: 'opaque-capability' })
    expect(fetcher).not.toHaveBeenCalled()
    expect(await unsub.unsubscribe()).toMatchObject({ state: 'success', failed: false })
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
      `/api/newsletter/${mode === 'all' ? 'unsubscribe-all' : 'unsubscribe'}`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"capability":"opaque-capability"}' }
    )
  })
})

describe.each(['single', 'all'] as const)('%s unsubscribe lifecycle', mode => {
  const selected = mode === 'all' ? 'unsubscribeAll' : 'unsubscribe'
  const other = mode === 'all' ? 'unsubscribe' : 'unsubscribeAll'

  it('supports a custom client with only the selected action and guards loading/success until reset', async () => {
    const pending = deferredResult()
    const action = vi.fn(() => pending.promise)
    const client = mode === 'all' ? { unsubscribeAll: action } : { unsubscribe: action }
    const unsub = useNewsletterUnsubscribe({ mode, token: 'capability', client: () => client })
    const request = unsub.unsubscribe()
    expect(unsub.loading.value).toBe(true)
    expect(await unsub.unsubscribe()).toBeUndefined()
    expect(action).toHaveBeenCalledExactlyOnceWith('capability')
    pending.accept()
    await request
    expect(unsub.state.value).toBe('success')
    expect(unsub.loading.value).toBe(false)
    expect(await unsub.unsubscribe()).toBeUndefined()
    expect(action).toHaveBeenCalledTimes(1)
    unsub.reset()
    await unsub.unsubscribe()
    expect(action).toHaveBeenCalledTimes(2)
  })

  it('uses the selected method when both methods are present, preserving its receiver', async () => {
    const client = {
      unsubscribe: vi.fn(function (this: unknown) { expect(this).toBe(client); return Promise.resolve({ unsubscribed: true } as const) }),
      unsubscribeAll: vi.fn(function (this: unknown) { expect(this).toBe(client); return Promise.resolve({ unsubscribed: true } as const) })
    }
    const unsub = useNewsletterUnsubscribe({ mode, token: 'capability', client })
    await unsub.unsubscribe()
    expect(client[selected]).toHaveBeenCalledExactlyOnceWith('capability')
    expect(client[other]).not.toHaveBeenCalled()
  })

  it('reports a missing selected action without falling back to the other scope', async () => {
    const action = vi.fn()
    const client = mode === 'all' ? { unsubscribe: action } : { unsubscribeAll: action }
    const unsub = useNewsletterUnsubscribe({ mode, token: 'capability', client })
    expect(await unsub.unsubscribe()).toMatchObject({ state: 'error', failed: true })
    expect(unsub.error.value).toEqual(new Error(`Newsletter client does not support ${selected}.`))
    expect(unsub.loading.value).toBe(false)
    expect(action).not.toHaveBeenCalled()
  })

  it.each([undefined, ''])('does not send missing token %j', async token => {
    const action = vi.fn()
    const client = { unsubscribe: action, unsubscribeAll: action }
    const unsub = useNewsletterUnsubscribe({ mode, token, client })
    expect(await unsub.unsubscribe()).toBeUndefined()
    expect(unsub.displayState.value).toBe('invalid')
    expect(action).not.toHaveBeenCalled()
  })

  it('maps false responses and request failures and permits retry', async () => {
    const error = new Error('Server unavailable')
    const action = vi.fn()
      .mockResolvedValueOnce({ unsubscribed: false })
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce({ unsubscribed: true })
    const unsub = useNewsletterUnsubscribe({ mode, token: 'capability', client: { unsubscribe: action, unsubscribeAll: action } })
    expect(await unsub.unsubscribe()).toMatchObject({ state: 'invalid', failed: false })
    expect(unsub.resultDescription.value).toBe(unsub.messages.value.unsubscribe.invalid)
    expect(await unsub.unsubscribe()).toMatchObject({ state: 'error', failed: true, error })
    expect(unsub.resultTitle.value).toBe(unsub.messages.value.common.error)
    expect(await unsub.unsubscribe()).toMatchObject({ state: 'success', failed: false })
    expect(unsub.error.value).toBeUndefined()
  })

  it.each(['reset', 'token change', 'disposal'] as const)('ignores a pending response after %s', async invalidate => {
    const first = deferredResult()
    const second = deferredResult()
    const action = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const token = ref('old-capability')
    const scope = effectScope()
    const unsub = scope.run(() => useNewsletterUnsubscribe({ mode, token, client: { unsubscribe: action, unsubscribeAll: action } }))!
    const oldRequest = unsub.unsubscribe()
    if (invalidate === 'reset') unsub.reset()
    if (invalidate === 'token change') token.value = 'new-capability'
    if (invalidate === 'disposal') scope.stop()
    else expect(unsub.state.value).toBe('idle')

    const newRequest = invalidate === 'disposal' ? undefined : unsub.unsubscribe()
    first.accept()
    expect(await oldRequest).toBeUndefined()
    expect(unsub.state.value).toBe('loading')
    expect(unsub.error.value).toBeUndefined()
    if (invalidate !== 'disposal') {
      expect(action).toHaveBeenLastCalledWith(token.value)
      second.accept()
      expect(await newRequest).toMatchObject({ state: 'success', failed: false })
    }
    scope.stop()
  })
})

describe('unsubscribe-all capability authorization', () => {
  it('keeps audience-scoped capabilities restricted through the browser client and all-mode composable', async () => {
    const service = betterNewsletter({
      storage: memoryAdapter(), capabilities: memoryCapabilities(),
      mailer: { sendConfirmation: async () => ({ accepted: true }) }
    })
    const email = 'user@example.com'
    for (const audience of ['default', 'product']) {
      await service.subscribe({ email, audience, consent: { granted: true, version: 'v1', source: 'test' } })
    }
    const single = await service.createUnsubscribeCapability({ email, audience: 'default' })
    const all = await service.createUnsubscribeCapability({ email, all: true })
    expect(single).toBeTypeOf('string')
    expect(all).toBeTypeOf('string')
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('/api/newsletter/unsubscribe-all')
      expect(init.method).toBe('POST')
      const body = JSON.parse(init.body as string) as { capability: string }
      const result = await service.unsubscribeAll(body)
      return new Response(JSON.stringify(result))
    })
    const client = createNewsletterClient(undefined, fetcher)
    const invalid = useNewsletterUnsubscribe({ mode: 'all', token: single!, client })
    expect(await invalid.unsubscribe()).toMatchObject({ state: 'invalid', failed: false })
    for (const audience of ['default', 'product']) {
      expect((await service.getSubscription({ email, audience }))?.status).toBe(SUBSCRIPTION_STATUSES.PENDING_CONFIRMATION)
    }

    const authorized = useNewsletterUnsubscribe({ mode: 'all', token: all!, client })
    expect(await authorized.unsubscribe()).toMatchObject({ state: 'success', failed: false })
    for (const audience of ['default', 'product']) {
      expect((await service.getSubscription({ email, audience }))?.status).toBe(SUBSCRIPTION_STATUSES.UNSUBSCRIBED)
    }
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
})
