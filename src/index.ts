export {
  createNewsletter,
  DEFAULT_CONFIRMATION_EXPIRES_IN_MS,
  systemClock
} from './create-newsletter.js'

export type {
  Clock,
  ConfirmationOptions,
  NewsletterConfig,
  NewsletterCore,
  TokenGenerator
} from './config.js'

export {
  CONTACT_STATUSES,
  NEWSLETTER_EVENT_TYPES,
  SUBSCRIPTION_STATUSES
} from './domain.js'

export type {
  ConsentEvidence,
  Contact,
  ContactStatus,
  ExternalSubject,
  JsonPrimitive,
  JsonValue,
  NewsletterEvent,
  NewsletterEventType,
  Subscription,
  SubscriptionStatus
} from './domain.js'

export {
  DELIVERY_INELIGIBILITY_REASONS,
  getDeliveryEligibility,
  isEligibleForDelivery
} from './eligibility.js'

export type {
  DeliveryEligibility,
  DeliveryIneligibilityReason
} from './eligibility.js'

export {
  NEWSLETTER_ERROR_CODES,
  NewsletterError
} from './errors.js'

export type {
  NewsletterErrorCode
} from './errors.js'

export {
  assertAudienceKey,
  DEFAULT_AUDIENCE_KEY,
  normalizeEmail
} from './normalize.js'
