import type { Contact, Subscription } from './domain.js'
import type { DeliveryEligibility } from './eligibility.js'

export interface Clock {
  now(): Date
}

export interface TokenGenerator {
  generate(): Promise<string> | string
}

export interface ConfirmationOptions {
  readonly expiresInMs?: number
}

export interface NewsletterConfig<TStorage, TMailer> {
  readonly storage: TStorage
  readonly mailer: TMailer
  readonly clock?: Clock
  readonly tokenGenerator?: TokenGenerator
  readonly defaultAudience?: string
  readonly confirmation?: ConfirmationOptions
}

export interface NewsletterCore<TStorage, TMailer> {
  readonly storage: TStorage
  readonly mailer: TMailer
  readonly clock: Clock
  readonly tokenGenerator: TokenGenerator | undefined
  readonly defaultAudience: string
  readonly confirmation: {
    readonly expiresInMs: number
  }

  getDeliveryEligibility(
    contact: Contact,
    subscription: Subscription
  ): DeliveryEligibility
}
