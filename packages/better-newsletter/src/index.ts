export {
  betterNewsletter,
  DEFAULT_CONFIRMATION_CLEANUP_RETENTION_MS,
  DEFAULT_CONFIRMATION_DELIVERY_LEASE_MS,
  DEFAULT_CONFIRMATION_EXPIRES_IN_MS,
  DEFAULT_MAX_ACTIVE_CONFIRMATION_TOKENS,
  DEFAULT_RESEND_RATE_LIMIT,
  DEFAULT_SUBSCRIBE_RATE_LIMIT,
  DEFAULT_TRANSACTION_MAX_ATTEMPTS
} from './create-newsletter.js'

export type {
  ConfirmationOptions,
  BetterNewsletterOptions,
  BetterNewsletter,
  NewsletterLogger,
  NewsletterRateLimits
} from './config.js'

export {
  CONTACT_STATUSES,
  DELIVERY_FEEDBACK_TYPES,
  NEWSLETTER_EVENT_TYPES,
  SUBSCRIPTION_STATUSES
} from './domain.js'

export type {
  ConsentEvidence,
  ConfirmationDelivery,
  Contact,
  ContactStatus,
  DeliveryFeedback,
  DeliveryFeedbackType,
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
  NewsletterError,
  StorageConflictError
} from './errors.js'

export type {
  NewsletterErrorCode,
  NewsletterErrorOptions
} from './errors.js'

export {
  assertAudienceKey,
  DEFAULT_AUDIENCE_KEY,
  normalizeAndValidateEmail,
  normalizeEmail
} from './normalize.js'

export type {
  ConfirmInput,
  ConfirmResult,
  ContactLookup,
  CleanupConfirmationTokensInput,
  CreateUnsubscribeCapabilityInput,
  ImportSubscriptionInput,
  LinkSubjectInput,
  PublicRequestResult,
  PreferenceSubscription,
  ResendConfirmationInput,
  SubscribeInput,
  SubscriptionLookup,
  SuppressContactInput,
  UnsubscribeInput,
  UnsubscribeResult,
  UnsuppressContactInput
} from './operations.js'

export {
  CONFIRMATION_REPLACEMENT_STRATEGIES
} from './security.js'
