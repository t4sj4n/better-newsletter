import type {
  Clock,
  NewsletterConfig,
  NewsletterCore
} from './config.js'
import { getDeliveryEligibility } from './eligibility.js'
import {
  NEWSLETTER_ERROR_CODES,
  NewsletterError
} from './errors.js'
import {
  assertAudienceKey,
  DEFAULT_AUDIENCE_KEY
} from './normalize.js'

export const DEFAULT_CONFIRMATION_EXPIRES_IN_MS = 24 * 60 * 60 * 1000

export const systemClock: Clock = {
  now: () => new Date()
}

export function createNewsletter<TStorage, TMailer>(
  config: NewsletterConfig<TStorage, TMailer>
): NewsletterCore<TStorage, TMailer> {
  const defaultAudience = assertAudienceKey(
    config.defaultAudience ?? DEFAULT_AUDIENCE_KEY
  )
  const expiresInMs =
    config.confirmation?.expiresInMs
    ?? DEFAULT_CONFIRMATION_EXPIRES_IN_MS

  if (!Number.isSafeInteger(expiresInMs) || expiresInMs <= 0) {
    throw new NewsletterError(
      NEWSLETTER_ERROR_CODES.INVALID_CONFIGURATION,
      'confirmation.expiresInMs must be a positive safe integer.'
    )
  }

  return Object.freeze({
    storage: config.storage,
    mailer: config.mailer,
    clock: config.clock ?? systemClock,
    tokenGenerator: config.tokenGenerator,
    defaultAudience,
    confirmation: Object.freeze({ expiresInMs }),
    getDeliveryEligibility
  })
}
