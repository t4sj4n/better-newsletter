export {
  createNewsletter,
  DEFAULT_CONFIRMATION_CLEANUP_RETENTION_MS,
  DEFAULT_CONFIRMATION_DELIVERY_LEASE_MS,
  DEFAULT_CONFIRMATION_EXPIRES_IN_MS,
  DEFAULT_MAX_ACTIVE_CONFIRMATION_TOKENS,
  DEFAULT_RESEND_RATE_LIMIT,
  DEFAULT_SUBSCRIBE_RATE_LIMIT,
  DEFAULT_TRANSACTION_MAX_ATTEMPTS,
  systemClock,
  systemIdGenerator
} from './create-newsletter.js'

export type {
  BackgroundTaskRunner,
  Clock,
  ConfirmationOptions,
  IdGenerator,
  NewsletterConfig,
  NewsletterCore,
  NewsletterLogger,
  NewsletterRateLimitCheck,
  NewsletterRateLimits,
  TokenGenerator
} from './config.js'

export type {
  ConfirmationCapabilityTarget,
  ConfirmationReplacementResult,
  NewsletterCapabilities,
  UnsubscribeCapabilityTarget
} from './capabilities.js'

export {
  CONTACT_STATUSES,
  NEWSLETTER_EVENT_TYPES,
  SUBSCRIPTION_STATUSES
} from './domain.js'

export type {
  ConsentEvidence,
  ConfirmationDelivery,
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
  NewsletterError,
  StorageConflictError
} from './errors.js'

export type {
  NewsletterErrorCode,
  NewsletterErrorOptions
} from './errors.js'

export { MAIL_DELIVERY_FAILURES, MAIL_DELIVERY_REASONS } from './mailer.js'

export type {
  ConfirmationMailInput,
  MailDeliveryFailure,
  MailDeliveryReasonCode,
  MailDeliveryResult,
  NewsletterMailer
} from './mailer.js'

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
  NewsletterService,
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

export type {
  ContactPatch,
  CreateContactInput,
  CreateSubscriptionInput,
  NewsletterStorage,
  NewsletterStorageTransaction,
  SubscriptionPatch
} from './storage.js'

export {
  CAPABILITY_PURPOSES,
  CONFIRMATION_REPLACEMENT_STRATEGIES,
  createHmacRateLimitKeyProvider,
  createSecureCapabilities,
  secureTokenGenerator,
  sha256Digest
} from './security.js'

export type {
  AbuseGuard,
  CapabilityPurpose,
  ConfirmationReplacementStrategy,
  ConfirmationTokenRecord,
  ConfirmationTokenStore,
  HmacRateLimitKeyProviderOptions,
  PublicAbuseAction,
  RateLimiter,
  RateLimitKeyProvider,
  RateLimitPolicy,
  SecureCapabilitiesOptions
} from './security.js'
