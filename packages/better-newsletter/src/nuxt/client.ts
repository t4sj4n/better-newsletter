import { assertNewsletterBasePath, newsletterRoutes, type NewsletterRoutingOptions } from './routing.js'
export type { NewsletterRoutingOptions, NewsletterRoute, NewsletterRoutes } from './routing.js'
type Fetcher = (url: string, init: RequestInit) => Promise<Response>

/** UI-agnostic browser helper; configure paths to match the Nuxt module. */
export function createNewsletterClient(
  { basePath = '/api/newsletter', routes: overrides }: NewsletterRoutingOptions = {},
  fetcher: Fetcher = fetch
) {
  assertNewsletterBasePath(basePath)
  const routes = newsletterRoutes(overrides)
  async function post(route: string | false, body: object): Promise<unknown> {
    if (!route) throw new Error('This newsletter route is disabled.')
    const response = await fetcher(`${basePath}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })
    if (!response.ok) throw new Error(`Newsletter request failed (${response.status}).`)
    return response.json()
  }
  return {
    subscribe: (input: { email: string; audience?: string; audiences?: string[]; consent: true; consentVersion: string }) =>
      post(routes.subscribe, input),
    resendConfirmation: (input: { email: string; audience?: string }) =>
      post(routes.resendConfirmation, input),
    confirm: (token: string) => post(routes.confirm, { token }),
    unsubscribe: (capability: string) => post(routes.unsubscribe, { capability }),
    unsubscribeAll: (capability: string) => post(routes.unsubscribeAll, { capability }),
    preferences: (capability: string) => post(routes.preferences, { capability })
  }
}
