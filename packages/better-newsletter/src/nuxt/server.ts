import { createNewsletterWithSubscriptionBatch } from '../create-newsletter.js'
import type { NewsletterRoutes } from './routing.js'
import type { JsonValue } from '../domain.js'
import type { SubscribeInput } from '../operations.js'
import type { H3Event } from 'h3'
import type {
  BetterNewsletterOptions,
  BetterNewsletter,
  NewsletterRateLimits
} from '../config.js'
import { createHmacRateLimitKeyProvider, type RateLimiter } from '../security.js'

export interface BetterNewsletterServerConfig extends Omit<BetterNewsletterOptions, 'runBackground' | 'rateLimitChecks'> {
  /** Public HTTP policy; never serialized into Nuxt module options. */
  readonly publicApi?: {
    readonly defaultAudience?: string
    readonly audiences?: Record<string, { public: boolean }>
    readonly consent?: { version: string; source: string }
    readonly routes?: Partial<NewsletterRoutes>
  }
  /** Absolute trusted application origin, never computed from request headers. */
  readonly origin: string
  /** Host-approved client identity; never read arbitrary forwarded headers here. */
  readonly trustedClientIdentity?: (event: H3Event) => string | Promise<string>
  readonly clientRateLimit?: {
    readonly secret: string | Uint8Array
    readonly limiter: RateLimiter
    readonly policies?: NewsletterRateLimits
  }
  /** Select and validate persistent host metadata for public subscribe requests. */
  readonly publicSubscribeMetadata?: (
    event: H3Event,
    body: Readonly<Record<string, unknown>>
  ) => Readonly<Record<string, JsonValue>> | undefined
    | Promise<Readonly<Record<string, JsonValue>> | undefined>
  /** Optional application-owned CAPTCHA or abuse metadata for the core guard. */
  readonly securityContext?: (
    event: H3Event,
    body: Readonly<Record<string, unknown>>
  ) => unknown | Promise<unknown>
  /** Attach to the host's waitUntil when supported, otherwise await before replying. */
  readonly backgroundMode?: 'auto' | 'await'
}

export const defineBetterNewsletterConfig = (
  factory: () => BetterNewsletterServerConfig | Promise<BetterNewsletterServerConfig>
): typeof factory => factory

const requestServices = new WeakMap<H3Event, {
  service: Promise<BetterNewsletter>
  tasks: Promise<void>[]
}>()
const requestBatches = new WeakMap<H3Event, ReturnType<typeof createNewsletterWithSubscriptionBatch>['subscribeMany']>()
const requestConfigs = new WeakMap<H3Event, Promise<BetterNewsletterServerConfig>>()

export type NewsletterServerConfiguration = BetterNewsletterServerConfig
  | (() => BetterNewsletterServerConfig | Promise<BetterNewsletterServerConfig>)

/** Shares the server-only configuration between HTTP routing and trusted service access. */
export function newsletterServerConfig(
  event: H3Event,
  configuration?: NewsletterServerConfiguration
): Promise<BetterNewsletterServerConfig> {
  const existing = requestConfigs.get(event)
  if (existing != null) return existing
  const config = (async () => configuration == null
    ? (await import('#better-newsletter-config')).default()
    : typeof configuration === 'function' ? configuration() : configuration)()
  requestConfigs.set(event, config)
  return config
}

function assertOrigin(origin: string): void {
  const url = new URL(origin)
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password
    || url.search || url.hash || url.pathname !== '/' || url.origin !== origin.replace(/\/$/u, '')) {
    throw new Error('Newsletter origin must be a trusted absolute HTTP(S) origin.')
  }
}

export function newsletterUrl(origin: string, path: string, token: string): string {
  assertOrigin(origin)
  if (!path.startsWith('/') || path.startsWith('//')) {
    throw new Error('Newsletter link path must start with a single slash.')
  }
  const url = new URL(path, origin)
  if (url.origin !== new URL(origin).origin) {
    throw new Error('Newsletter link path must remain on the trusted origin.')
  }
  url.searchParams.set('token', token)
  return url.toString()
}

export async function useBetterNewsletter(
  event: H3Event,
  configuration?: NewsletterServerConfiguration
): Promise<BetterNewsletter> {
  const existing = requestServices.get(event)
  if (existing != null) return existing.service
  const tasks: Promise<void>[] = []
  const service = (async () => {
    const config = await newsletterServerConfig(event, configuration)
    assertOrigin(config.origin)
    if ((config.clientRateLimit == null) !== (config.trustedClientIdentity == null)) {
      throw new Error('Client rate limiting requires both a limiter and a trusted identity resolver.')
    }
    const identity = config.trustedClientIdentity == null
      ? undefined
      : await config.trustedClientIdentity(event)
    if (config.clientRateLimit != null && !identity?.trim()) {
      throw new Error('Trusted client identity is required for configured client rate limits.')
    }
    const clientRateLimit = config.clientRateLimit
    const rateLimitChecks = clientRateLimit == null ? [] : [{
      rateLimiter: clientRateLimit.limiter,
      keyProvider: createHmacRateLimitKeyProvider({
        secret: clientRateLimit.secret,
        material: input => `${input.action}\u0000${identity}`
      }),
      ...(clientRateLimit.policies === undefined ? {} : { rateLimits: clientRateLimit.policies })
    }]
    const batch = createNewsletterWithSubscriptionBatch({
      ...config,
      ...(rateLimitChecks.length === 0 ? {} : { rateLimitChecks }),
      runBackground(task) {
        // Nitro's event.waitUntil may only queue in-process tasks. Only a
        // platform-supplied waitUntil extends the actual request lifetime.
        if (config.backgroundMode !== 'await' && typeof event.context.waitUntil === 'function') {
          event.context.waitUntil(task)
        } else {
          tasks.push(task)
        }
      }
    })
    requestBatches.set(event, batch.subscribeMany)
    const core = batch.service
    const safeService: BetterNewsletter = {
      ...core,
      async subscribe(input) {
        try {
          return await core.subscribe(input)
        } finally {
          await flushBetterNewsletter(event)
        }
      },
      async resendConfirmation(input) {
        try {
          return await core.resendConfirmation(input)
        } finally {
          await flushBetterNewsletter(event)
        }
      }
    }
    return safeService
  })()
  requestServices.set(event, { service, tasks })
  return service
}

export async function newsletterPublicSubscribeMetadata(
  event: H3Event,
  body: Readonly<Record<string, unknown>>
): Promise<Readonly<Record<string, JsonValue>> | undefined> {
  return (await requestConfigs.get(event))?.publicSubscribeMetadata?.(event, body)
}

export async function newsletterSecurityContext(
  event: H3Event,
  body: Readonly<Record<string, unknown>>
): Promise<unknown> {
  return (await requestConfigs.get(event))?.securityContext?.(event, body)
}

/** Waits for any queued delivery work; public service methods flush automatically. */
export async function flushBetterNewsletter(event: H3Event): Promise<void> {
  const request = requestServices.get(event)
  if (request == null) return
  for (let index = 0; index < request.tasks.length; index += 1) {
    await request.tasks[index]
  }
}

/** Runs all audience security checks before subscribing any audience. */
export async function subscribeNewsletterAudiences(event: H3Event, inputs: readonly SubscribeInput[]): Promise<void> {
  await useBetterNewsletter(event)
  try {
    await requestBatches.get(event)!(inputs)
  } finally {
    await flushBetterNewsletter(event)
  }
}
