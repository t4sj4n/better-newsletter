import type { NewsletterCapabilities } from './capabilities.js'
import type { NewsletterMailer } from './mailer.js'
import type { NewsletterService } from './operations.js'
import type {
  AbuseGuard,
  ConfirmationReplacementStrategy,
  RateLimiter,
  RateLimitKeyProvider,
  RateLimitPolicy
} from './security.js'
import type { NewsletterStorage } from './storage.js'

export interface Clock {
  now(): Date
}

export interface TokenGenerator {
  generate(): Promise<string> | string
}

export interface IdGenerator {
  generate(): string
}

export interface ConfirmationOptions {
  readonly expiresInMs?: number
  readonly replacementStrategy?: ConfirmationReplacementStrategy
  readonly maxActiveTokens?: number
  readonly cleanupRetentionMs?: number
  readonly deliveryLeaseMs?: number
}

/** Receives background work, e.g. to pass it to a runtime's `waitUntil()`. */
export type BackgroundTaskRunner = (task: Promise<void>) => void

export interface NewsletterLogger {
  error(message: string, error?: unknown): void
}

export interface NewsletterRateLimits {
  readonly subscribe?: RateLimitPolicy
  readonly resendConfirmation?: RateLimitPolicy
}

export interface NewsletterRateLimitCheck {
  readonly rateLimiter: RateLimiter
  readonly keyProvider: RateLimitKeyProvider
  readonly rateLimits?: NewsletterRateLimits
}

export interface BetterNewsletterOptions {
  readonly storage: NewsletterStorage
  readonly mailer: NewsletterMailer
  readonly capabilities: NewsletterCapabilities
  readonly tokenGenerator?: TokenGenerator
  readonly idGenerator?: IdGenerator
  readonly clock?: Clock
  readonly defaultAudience?: string
  readonly confirmation?: ConfirmationOptions
  readonly feedbackPolicy?: {
    readonly suppressOnComplaint?: boolean
    readonly suppressOnHardBounce?: boolean
    readonly suppressOnProviderSuppression?: boolean
    /** Suppress on the Nth distinct soft bounce. Omit to record only. */
    readonly softBounceThreshold?: number
  }
  readonly abuseGuard?: AbuseGuard
  readonly rateLimiter?: RateLimiter
  readonly rateLimitKeyProvider?: RateLimitKeyProvider
  readonly rateLimits?: NewsletterRateLimits
  /** Additional independent, opaque-key limits checked before storage work. */
  readonly rateLimitChecks?: readonly NewsletterRateLimitCheck[]
  /**
   * Background tasks never reject; failures are reported through `logger`.
   * Without a runner, tasks run detached in the current process.
   */
  readonly runBackground?: BackgroundTaskRunner
  /** Defaults to `console`. */
  readonly logger?: NewsletterLogger
  /** Attempts per transaction when storage reports a conflict. Defaults to 3. */
  readonly transactionMaxAttempts?: number
  /** Current digest first, followed by digests from still-active older keys. */
  readonly suppressionKeyProvider?: (normalizedEmail: string) => Promise<string | readonly string[]> | string | readonly string[]
}

export type BetterNewsletter = NewsletterService
