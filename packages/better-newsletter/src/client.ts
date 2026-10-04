import {
  assertNewsletterBasePath,
  newsletterRoutes,
  type NewsletterRoute,
  type NewsletterRoutes,
  type NewsletterRoutingOptions
} from './routing.js'
import type {
  ConfirmResult,
  PreferenceSubscription,
  UnsubscribeResult
} from './operations.js'

export type {
  NewsletterRoute,
  NewsletterRoutes,
  NewsletterRoutingOptions
} from './routing.js'

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>

export interface NewsletterClientSubscribeInput {
  readonly email: string
  readonly audience?: string
  readonly audiences?: readonly string[]
  readonly consent: true
  readonly consentVersion: string
}

export interface NewsletterClientResendConfirmationInput {
  readonly email: string
  readonly audience?: string
}

export interface NewsletterClientSubscribeResult {
  readonly accepted: true
}

export interface NewsletterClientResendConfirmationResult {
  readonly accepted: true
}

export type NewsletterClientConfirmResult = ConfirmResult

export type NewsletterClientUnsubscribeResult = UnsubscribeResult

export interface NewsletterClientPreferencesResult {
  readonly subscriptions: readonly PreferenceSubscription[] | null
}

export interface NewsletterClient {
  subscribe(input: NewsletterClientSubscribeInput): Promise<NewsletterClientSubscribeResult>
  resendConfirmation(input: NewsletterClientResendConfirmationInput): Promise<NewsletterClientResendConfirmationResult>
  confirm(token: string): Promise<NewsletterClientConfirmResult>
  unsubscribe(capability: string): Promise<NewsletterClientUnsubscribeResult>
  unsubscribeAll(capability: string): Promise<NewsletterClientUnsubscribeResult>
  preferences(capability: string): Promise<NewsletterClientPreferencesResult>
}

/** Framework-neutral browser helper; configure paths to match the server mount and action routes. */
export function createNewsletterClient(
  { basePath = '/api/newsletter', routes: overrides }: NewsletterRoutingOptions = {},
  fetcher: Fetcher = fetch
): NewsletterClient {
  assertNewsletterBasePath(basePath)
  const routes = newsletterRoutes(overrides)

  async function post<T>(route: string | false, body: object): Promise<T> {
    if (!route) throw new Error('This newsletter route is disabled.')
    const response = await fetcher(`${basePath}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })
    if (!response.ok) throw new Error(`Newsletter request failed (${response.status}).`)
    return (await response.json()) as T
  }

  return {
    subscribe: (input: NewsletterClientSubscribeInput) =>
      post<NewsletterClientSubscribeResult>(routes.subscribe, input),
    resendConfirmation: (input: NewsletterClientResendConfirmationInput) =>
      post<NewsletterClientResendConfirmationResult>(routes.resendConfirmation, input),
    confirm: (token: string) =>
      post<NewsletterClientConfirmResult>(routes.confirm, { token }),
    unsubscribe: (capability: string) =>
      post<NewsletterClientUnsubscribeResult>(routes.unsubscribe, { capability }),
    unsubscribeAll: (capability: string) =>
      post<NewsletterClientUnsubscribeResult>(routes.unsubscribeAll, { capability }),
    preferences: (capability: string) =>
      post<NewsletterClientPreferencesResult>(routes.preferences, { capability })
  }
}
