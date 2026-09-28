export {
  createNewsletter,
  DEFAULT_CONFIRMATION_EXPIRES_IN_MS,
  systemClock,
  systemIdGenerator
} from './create-newsletter.js'

export type {
  Clock,
  ConfirmationOptions,
  IdGenerator,
  NewsletterConfig,
  NewsletterCore,
  TokenGenerator
} from './config.js'

export type {
  ConfirmationCapabilityTarget,
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

export type {
  ConfirmationMailInput,
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
  CreateUnsubscribeCapabilityInput,
  ImportSubscriptionInput,
  LinkSubjectInput,
  NewsletterService,
  PublicRequestResult,
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
