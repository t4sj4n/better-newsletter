/** Package-owned action paths, independent of Nitro or other web frameworks. */
export const defaultNewsletterRoutes = Object.freeze({
  subscribe: '/subscribe',
  resendConfirmation: '/resend-confirmation',
  confirm: '/confirm',
  unsubscribe: '/unsubscribe',
  unsubscribeAll: '/unsubscribe-all',
  preferences: '/preferences'
})

export type NewsletterRoute = keyof typeof defaultNewsletterRoutes
export type NewsletterRoutes = Record<NewsletterRoute, string | false>
export interface NewsletterRoutingOptions {
  /** Mount path without a trailing slash. Defaults to /api/newsletter. */
  basePath?: string
  /** Action paths relative to the mount, or false to disable an action. */
  routes?: Partial<NewsletterRoutes>
}

function validPath(path: string): boolean {
  return /^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/u.test(path)
}

export function assertNewsletterBasePath(path: string): void {
  if (!validPath(path)) throw new Error(`Invalid newsletter base path: ${path}`)
}

export function newsletterRoutes(overrides: Partial<NewsletterRoutes> = {}): NewsletterRoutes {
  const routes = { ...defaultNewsletterRoutes, ...overrides }
  const registered = new Set<string>()
  for (const [action, path] of Object.entries(routes)) {
    if (!(Object.hasOwn(defaultNewsletterRoutes, action))) throw new Error(`Unknown newsletter action: ${action}`)
    if (path === false) continue
    if (typeof path !== 'string' || !validPath(path) || registered.has(path)) {
      throw new Error(`Invalid or duplicate newsletter action path: ${path}`)
    }
    registered.add(path)
  }
  return routes
}
