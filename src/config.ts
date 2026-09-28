import type { NewsletterCapabilities } from './capabilities.js'
import type { Contact, Subscription } from './domain.js'
import type { DeliveryEligibility } from './eligibility.js'
import type { NewsletterMailer } from './mailer.js'
import type { NewsletterService } from './operations.js'
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
}

export interface NewsletterConfig {
  readonly storage: NewsletterStorage
  readonly mailer: NewsletterMailer
  readonly capabilities: NewsletterCapabilities
  readonly tokenGenerator: TokenGenerator
  readonly idGenerator?: IdGenerator
  readonly clock?: Clock
  readonly defaultAudience?: string
  readonly confirmation?: ConfirmationOptions
}

export interface NewsletterCore extends NewsletterService {
  readonly storage: NewsletterStorage
  readonly mailer: NewsletterMailer
  readonly capabilities: NewsletterCapabilities
  readonly clock: Clock
  readonly tokenGenerator: TokenGenerator
  readonly idGenerator: IdGenerator
  readonly defaultAudience: string
  readonly confirmation: {
    readonly expiresInMs: number
  }

  getDeliveryEligibility(
    contact: Contact,
    subscription: Subscription
  ): DeliveryEligibility
}
