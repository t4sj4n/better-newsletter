import type {
  Clock,
  IdGenerator,
  NewsletterConfig,
  NewsletterCore
} from './config.js'
import {
  CONTACT_STATUSES,
  NEWSLETTER_EVENT_TYPES,
  SUBSCRIPTION_STATUSES,
  type ConfirmationDelivery,
  type ConsentEvidence,
  type Contact,
  type ExternalSubject,
  type JsonValue,
  type NewsletterEventType,
  type Subscription
} from './domain.js'
import { getDeliveryEligibility } from './eligibility.js'
import {
  NEWSLETTER_ERROR_CODES,
  NewsletterError
} from './errors.js'
import {
  assertAudienceKey,
  DEFAULT_AUDIENCE_KEY,
  normalizeAndValidateEmail
} from './normalize.js'
import type {
  ContactLookup,
  ImportSubscriptionInput,
  SubscriptionLookup
} from './operations.js'
import {
  CONFIRMATION_REPLACEMENT_STRATEGIES,
  secureTokenGenerator,
  type PublicAbuseAction,
  type RateLimitPolicy
} from './security.js'
import type { NewsletterStorageTransaction } from './storage.js'

export const DEFAULT_CONFIRMATION_EXPIRES_IN_MS = 24 * 60 * 60 * 1000
export const DEFAULT_CONFIRMATION_CLEANUP_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
export const DEFAULT_CONFIRMATION_DELIVERY_LEASE_MS = 5 * 60 * 1000
export const DEFAULT_MAX_ACTIVE_CONFIRMATION_TOKENS = 2
export const DEFAULT_SUBSCRIBE_RATE_LIMIT = Object.freeze({
  limit: 5,
  windowMs: 60 * 60 * 1000
})
export const DEFAULT_RESEND_RATE_LIMIT = Object.freeze({
  limit: 3,
  windowMs: 10 * 60 * 1000
})

export const systemClock: Clock = {
  now: () => new Date()
}

export const systemIdGenerator: IdGenerator = {
  generate: () => crypto.randomUUID()
}

const PUBLIC_ACCEPTED = Object.freeze({ accepted: true as const })
const CONFIRMED = Object.freeze({ confirmed: true as const })
const NOT_CONFIRMED = Object.freeze({ confirmed: false as const })
const UNSUBSCRIBED = Object.freeze({ unsubscribed: true as const })
const NOT_UNSUBSCRIBED = Object.freeze({ unsubscribed: false as const })

/**
 * Builds consent evidence at the supplied time from explicit public consent.
 * @throws {NewsletterError} If consent is not granted or its version is blank.
 */
function consentFromPublicInput(
  input: {
    readonly granted: boolean
    readonly version: string
    readonly source?: string | null
    readonly locale?: string | null
  },
  now: Date
): ConsentEvidence {
  if (input.granted !== true) {
    throw new NewsletterError(
      NEWSLETTER_ERROR_CODES.CONSENT_REQUIRED,
      'Explicit newsletter consent is required.'
    )
  }

  const version = input.version.trim()
  if (version.length === 0) {
    throw new NewsletterError(
      NEWSLETTER_ERROR_CODES.CONSENT_REQUIRED,
      'A consent version is required.'
    )
  }

  return {
    version,
    consentedAt: now,
    ...(input.source !== undefined ? { source: input.source } : {}),
    ...(input.locale !== undefined ? { locale: input.locale } : {})
  }
}

/** Compares external subjects by namespace and ID, treating two nulls as equal. */
function subjectEquals(
  left: ExternalSubject | null,
  right: ExternalSubject | null
): boolean {
  return left?.namespace === right?.namespace && left?.id === right?.id
}

/** Compares timestamps, treating null and undefined as equivalent missing dates. */
function dateEquals(left: Date | null | undefined, right: Date | null | undefined): boolean {
  if (left == null || right == null) return left == null && right == null
  return left.getTime() === right.getTime()
}

/** Compares consent version, source, locale, and the recorded consent timestamp. */
function consentEquals(left: ConsentEvidence, right: ConsentEvidence): boolean {
  return left.version === right.version
    && left.source === right.source
    && left.locale === right.locale
    && left.consentedAt.getTime() === right.consentedAt.getTime()
}

function nextGeneration(generation: number): number {
  if (!Number.isSafeInteger(generation) || generation < 1 || generation === Number.MAX_SAFE_INTEGER) {
    throw new NewsletterError(
      NEWSLETTER_ERROR_CODES.INVALID_CONFIGURATION,
      'Cannot increment an invalid or exhausted capability generation.'
    )
  }
  return generation + 1
}

/**
 * Active imports require confirmation dates and no unsubscribe dates;
 * unsubscribed imports require unsubscribe dates, and pending imports neither.
 * @throws {NewsletterError} If these historical import requirements are unmet.
 */
function assertImportShape(input: ImportSubscriptionInput): void {
  if (
    input.status === SUBSCRIPTION_STATUSES.ACTIVE
    && (input.confirmedAt == null || input.unsubscribedAt != null)
  ) {
    throw new NewsletterError(
      NEWSLETTER_ERROR_CODES.INVALID_IMPORT,
      'Importing an active subscription requires confirmedAt and no unsubscribedAt.'
    )
  }

  if (
    input.status === SUBSCRIPTION_STATUSES.PENDING_CONFIRMATION
    && (input.confirmedAt != null || input.unsubscribedAt != null)
  ) {
    throw new NewsletterError(
      NEWSLETTER_ERROR_CODES.INVALID_IMPORT,
      'A pending imported subscription cannot be confirmed or unsubscribed.'
    )
  }

  if (
    input.status === SUBSCRIPTION_STATUSES.UNSUBSCRIBED
    && input.unsubscribedAt == null
  ) {
    throw new NewsletterError(
      NEWSLETTER_ERROR_CODES.INVALID_IMPORT,
      'Importing an unsubscribed subscription requires unsubscribedAt.'
    )
  }
}

/** Checks audience, status, consent, and lifecycle dates for an idempotent import. */
function importedSubscriptionMatches(
  existing: Subscription,
  input: ImportSubscriptionInput,
  audienceKey: string
): boolean {
  return existing.audienceKey === audienceKey
    && existing.status === input.status
    && consentEquals(existing.consent, input.consent)
    && dateEquals(existing.confirmedAt, input.confirmedAt)
    && dateEquals(existing.unsubscribedAt, input.unsubscribedAt)
}

/**
 * Creates a frozen newsletter lifecycle service using the supplied adapters.
 * Defaults to the system clock, UUID IDs, the default audience, and a 24-hour
 * confirmation lifetime when those options are omitted.
 * @throws {NewsletterError} If the audience or confirmation lifetime is invalid.
 */
export function createNewsletter(config: NewsletterConfig): NewsletterCore {
  const defaultAudience = assertAudienceKey(
    config.defaultAudience ?? DEFAULT_AUDIENCE_KEY
  )
  const expiresInMs =
    config.confirmation?.expiresInMs
    ?? DEFAULT_CONFIRMATION_EXPIRES_IN_MS
  const replacementStrategy =
    config.confirmation?.replacementStrategy
    ?? CONFIRMATION_REPLACEMENT_STRATEGIES.RETAIN_PREVIOUS_UNTIL_EXPIRY
  const maxActiveTokens =
    config.confirmation?.maxActiveTokens
    ?? DEFAULT_MAX_ACTIVE_CONFIRMATION_TOKENS
  const cleanupRetentionMs =
    config.confirmation?.cleanupRetentionMs
    ?? DEFAULT_CONFIRMATION_CLEANUP_RETENTION_MS
  const deliveryLeaseMs =
    config.confirmation?.deliveryLeaseMs
    ?? DEFAULT_CONFIRMATION_DELIVERY_LEASE_MS

  if (!Number.isSafeInteger(expiresInMs) || expiresInMs <= 0) {
    throw new NewsletterError(
      NEWSLETTER_ERROR_CODES.INVALID_CONFIGURATION,
      'confirmation.expiresInMs must be a positive safe integer.'
    )
  }
  if (!Number.isSafeInteger(maxActiveTokens) || maxActiveTokens <= 0) {
    throw new NewsletterError(
      NEWSLETTER_ERROR_CODES.INVALID_CONFIGURATION,
      'confirmation.maxActiveTokens must be a positive safe integer.'
    )
  }
  if (!Number.isSafeInteger(cleanupRetentionMs) || cleanupRetentionMs < 0) {
    throw new NewsletterError(
      NEWSLETTER_ERROR_CODES.INVALID_CONFIGURATION,
      'confirmation.cleanupRetentionMs must be a non-negative safe integer.'
    )
  }
  if (!Number.isSafeInteger(deliveryLeaseMs) || deliveryLeaseMs <= 0) {
    throw new NewsletterError(
      NEWSLETTER_ERROR_CODES.INVALID_CONFIGURATION,
      'confirmation.deliveryLeaseMs must be a positive safe integer.'
    )
  }
  if ((config.rateLimiter == null) !== (config.rateLimitKeyProvider == null)) {
    throw new NewsletterError(
      NEWSLETTER_ERROR_CODES.INVALID_CONFIGURATION,
      'rateLimiter and rateLimitKeyProvider must be configured together.'
    )
  }

  const validateRatePolicy = (name: string, policy: RateLimitPolicy): void => {
    if (
      !Number.isSafeInteger(policy.limit)
      || policy.limit <= 0
      || !Number.isSafeInteger(policy.windowMs)
      || policy.windowMs <= 0
    ) {
      throw new NewsletterError(
        NEWSLETTER_ERROR_CODES.INVALID_CONFIGURATION,
        `${name} must use positive safe integer limit and windowMs values.`
      )
    }
  }

  const subscribeRateLimit =
    config.rateLimits?.subscribe ?? DEFAULT_SUBSCRIBE_RATE_LIMIT
  const resendRateLimit =
    config.rateLimits?.resendConfirmation ?? DEFAULT_RESEND_RATE_LIMIT
  validateRatePolicy('rateLimits.subscribe', subscribeRateLimit)
  validateRatePolicy('rateLimits.resendConfirmation', resendRateLimit)

  const clock = config.clock ?? systemClock
  const idGenerator = config.idGenerator ?? systemIdGenerator
  const tokenGenerator = config.tokenGenerator ?? secureTokenGenerator
  const newConfirmationDelivery = (): ConfirmationDelivery => ({
    id: idGenerator.generate(),
    attemptId: null,
    leaseExpiresAt: null
  })

  const enforcePublicSecurity = async (
    action: PublicAbuseAction,
    email: string,
    audienceKey: string,
    context: unknown
  ): Promise<void> => {
    if (config.abuseGuard != null) {
      const result = await config.abuseGuard.verify({
        action,
        email,
        audienceKey,
        ...(context !== undefined ? { context } : {})
      })
      if (!result.allowed) {
        throw new NewsletterError(
          NEWSLETTER_ERROR_CODES.ABUSE_REJECTED,
          'The request was rejected by the configured abuse guard.'
        )
      }
    }

    if (config.rateLimiter != null && config.rateLimitKeyProvider != null) {
      const policy = action === 'subscribe'
        ? subscribeRateLimit
        : resendRateLimit
      const key = await config.rateLimitKeyProvider.createKey({
        action,
        email,
        audienceKey,
        ...(context !== undefined ? { context } : {})
      })
      if (key.length === 0) {
        throw new NewsletterError(
          NEWSLETTER_ERROR_CODES.INVALID_CONFIGURATION,
          'rateLimitKeyProvider returned an empty key.'
        )
      }
      const result = await config.rateLimiter.consume({
        key,
        action,
        limit: policy.limit,
        windowMs: policy.windowMs
      })
      if (!result.allowed) {
        throw new NewsletterError(
          NEWSLETTER_ERROR_CODES.RATE_LIMITED,
          'The request rate limit was exceeded.'
        )
      }
    }
  }

  const appendEvent = async (
    transaction: NewsletterStorageTransaction,
    input: {
      readonly contactId: string
      readonly subscriptionId?: string
      readonly type: NewsletterEventType
      readonly occurredAt: Date
      readonly metadata?: Readonly<Record<string, JsonValue>>
    }
  ): Promise<void> => {
    await transaction.appendEvent({
      id: idGenerator.generate(),
      contactId: input.contactId,
      ...(input.subscriptionId !== undefined
        ? { subscriptionId: input.subscriptionId }
        : {}),
      type: input.type,
      occurredAt: input.occurredAt,
      metadata: input.metadata ?? {}
    })
  }

  const resolveContact = async (
    transaction: NewsletterStorageTransaction,
    lookup: ContactLookup
  ): Promise<Contact | null> => {
    if ('email' in lookup) {
      return transaction.getContactByEmail(
        normalizeAndValidateEmail(lookup.email)
      )
    }
    return transaction.getContactById(lookup.id)
  }

  const requestConfirmation = async (
    contactId: string,
    subscriptionId: string,
    lifecycleGeneration: number
  ): Promise<void> => {
    const attemptId = idGenerator.generate()

    const state = await config.storage.transaction(async transaction => {
      const requestedAt = clock.now()
      const contact = await transaction.getContactById(contactId)
      const subscription = await transaction.getSubscriptionById(subscriptionId)

      if (
        contact == null
        || subscription == null
        || contact.status === CONTACT_STATUSES.SUPPRESSED
        || subscription.status !== SUBSCRIPTION_STATUSES.PENDING_CONFIRMATION
        || subscription.lifecycleGeneration !== lifecycleGeneration
        || subscription.confirmationDelivery == null
        || (
          subscription.confirmationDelivery.leaseExpiresAt != null
          && subscription.confirmationDelivery.leaseExpiresAt.getTime() > requestedAt.getTime()
        )
      ) {
        return null
      }

      await transaction.updateSubscription(subscriptionId, {
        confirmationDelivery: {
          ...subscription.confirmationDelivery,
          attemptId,
          leaseExpiresAt: new Date(requestedAt.getTime() + deliveryLeaseMs)
        }
      })
      await appendEvent(transaction, {
        contactId,
        subscriptionId,
        type: NEWSLETTER_EVENT_TYPES.CONFIRMATION_REQUESTED,
        occurredAt: requestedAt,
        metadata: { audienceKey: subscription.audienceKey, lifecycleGeneration, attemptId }
      })

      return { contact, subscription }
    })

    if (state == null) return

    let accepted = false
    let providerMessageId: string | undefined
    let stage = 'TOKEN_SETUP'
    try {
      const token = await tokenGenerator.generate()
      const issuedAt = clock.now()
      const expiresAt = new Date(issuedAt.getTime() + expiresInMs)

      const shouldSend = await config.storage.transaction(async transaction => {
        const current = await transaction.getSubscriptionById(subscriptionId)
        const contact = await transaction.getContactById(contactId)
        if (
          contact?.status !== CONTACT_STATUSES.ENABLED
          || current?.status !== SUBSCRIPTION_STATUSES.PENDING_CONFIRMATION
          || current.lifecycleGeneration !== lifecycleGeneration
          || current.confirmationDelivery?.attemptId !== attemptId
        ) return false

        // Fence token replacement as well as completion: a stale worker must
        // never replace tokens belonging to a newer delivery attempt.
        const replacement = await config.capabilities.replaceConfirmation({
          token,
          contactId,
          subscriptionId,
          lifecycleGeneration,
          issuedAt,
          expiresAt,
          replacementStrategy,
          maxActiveTokens
        })
        if (replacement != null) {
          for (const [type, count] of [
            [NEWSLETTER_EVENT_TYPES.CONFIRMATION_REPLACED, replacement.replacedCount],
            [NEWSLETTER_EVENT_TYPES.CONFIRMATION_EXPIRED, replacement.expiredCount]
          ] as const) {
            if (count > 0) {
              await appendEvent(transaction, {
                contactId, subscriptionId, type, occurredAt: issuedAt,
                metadata: { count, lifecycleGeneration }
              })
            }
          }
        }
        return true
      })
      if (!shouldSend) return

      stage = 'DELIVERY'
      const result = await config.mailer.sendConfirmation({
        contact: state.contact,
        subscription: state.subscription,
        token,
        expiresAt
      })
      accepted = result.accepted
      providerMessageId = result.providerMessageId
    } catch {
      accepted = false
    }

    const completedAt = clock.now()
    await config.storage.transaction(async transaction => {
      const current = await transaction.getSubscriptionById(subscriptionId)
      if (current == null) return

      if (
        current.lifecycleGeneration === lifecycleGeneration
        && current.status === SUBSCRIPTION_STATUSES.PENDING_CONFIRMATION
        && current.confirmationDelivery?.attemptId === attemptId
      ) {
        await transaction.updateSubscription(subscriptionId, {
          ...(accepted ? { confirmationSentAt: completedAt } : {}),
          confirmationDelivery: accepted
            ? null
            : { ...current.confirmationDelivery, attemptId: null, leaseExpiresAt: null },
          updatedAt: completedAt
        })
      }

      await appendEvent(transaction, {
        contactId,
        subscriptionId,
        type: accepted
          ? NEWSLETTER_EVENT_TYPES.CONFIRMATION_SENT
          : NEWSLETTER_EVENT_TYPES.CONFIRMATION_SEND_FAILED,
        occurredAt: completedAt,
        metadata: {
          lifecycleGeneration,
          attemptId,
          ...(!accepted ? { stage } : {}),
          ...(providerMessageId !== undefined ? { providerMessageId } : {})
        }
      })
    })
  }

  const service: NewsletterCore = {
    storage: config.storage,
    mailer: config.mailer,
    capabilities: config.capabilities,
    clock,
    tokenGenerator,
    idGenerator,
    defaultAudience,
    abuseGuard: config.abuseGuard,
    rateLimiter: config.rateLimiter,
    rateLimitKeyProvider: config.rateLimitKeyProvider,
    confirmation: Object.freeze({
      expiresInMs,
      replacementStrategy,
      maxActiveTokens,
      cleanupRetentionMs,
      deliveryLeaseMs
    }),
    getDeliveryEligibility,

    async subscribe(input) {
      const email = normalizeAndValidateEmail(input.email)
      const audienceKey = assertAudienceKey(input.audience ?? defaultAudience)
      const now = clock.now()
      const consent = consentFromPublicInput(input.consent, now)
      await enforcePublicSecurity(
        'subscribe',
        email,
        audienceKey,
        input.securityContext
      )

      const transition = await config.storage.transaction(async transaction => {
        let contact = await transaction.getContactByEmail(email)
        let contactCreated = false

        if (contact == null) {
          contact = await transaction.createContact({
            id: idGenerator.generate(),
            capabilityGeneration: 1,
            email,
            status: CONTACT_STATUSES.ENABLED,
            subject: input.subject ?? null,
            ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
            createdAt: now,
            updatedAt: now
          })
          contactCreated = true
        }

        let subscription = await transaction.getSubscription(
          contact.id,
          audienceKey
        )

        if (subscription == null) {
          if (!contactCreated) {
            contact = await transaction.updateContact(contact.id, {
              capabilityGeneration: nextGeneration(contact.capabilityGeneration),
              updatedAt: now
            })
          }

          subscription = await transaction.createSubscription({
            id: idGenerator.generate(),
            lifecycleGeneration: 1,
            contactId: contact.id,
            audienceKey,
            status: SUBSCRIPTION_STATUSES.PENDING_CONFIRMATION,
            consent,
            confirmationDelivery: newConfirmationDelivery(),
            confirmationSentAt: null,
            confirmedAt: null,
            unsubscribedAt: null,
            createdAt: now,
            updatedAt: now
          })

          await appendEvent(transaction, {
            contactId: contact.id,
            subscriptionId: subscription.id,
            type: NEWSLETTER_EVENT_TYPES.SIGNED_UP,
            occurredAt: now,
            metadata: {
              audienceKey,
              consentVersion: consent.version,
              ...(consent.source != null ? { source: consent.source } : {})
            }
          })

          return {
            contact,
            subscription,
            shouldSend: contact.status === CONTACT_STATUSES.ENABLED
          }
        }

        if (subscription.status === SUBSCRIPTION_STATUSES.UNSUBSCRIBED) {
          contact = await transaction.updateContact(contact.id, {
            capabilityGeneration: nextGeneration(contact.capabilityGeneration),
            updatedAt: now
          })
          subscription = await transaction.updateSubscription(subscription.id, {
            status: SUBSCRIPTION_STATUSES.PENDING_CONFIRMATION,
            lifecycleGeneration: nextGeneration(subscription.lifecycleGeneration),
            consent,
            confirmationDelivery: newConfirmationDelivery(),
            confirmationSentAt: null,
            confirmedAt: null,
            unsubscribedAt: null,
            updatedAt: now
          })

          await appendEvent(transaction, {
            contactId: contact.id,
            subscriptionId: subscription.id,
            type: NEWSLETTER_EVENT_TYPES.RESUBSCRIBED,
            occurredAt: now,
            metadata: {
              audienceKey,
              consentVersion: consent.version,
              ...(consent.source != null ? { source: consent.source } : {})
            }
          })

          return {
            contact,
            subscription,
            shouldSend: contact.status === CONTACT_STATUSES.ENABLED
          }
        }

        return {
          contact,
          subscription,
          shouldSend: contact.status === CONTACT_STATUSES.ENABLED
            && subscription.status === SUBSCRIPTION_STATUSES.PENDING_CONFIRMATION
            && subscription.confirmationDelivery != null
        }
      })

      if (transition.shouldSend) {
        void requestConfirmation(
          transition.contact.id,
          transition.subscription.id,
          transition.subscription.lifecycleGeneration
        ).catch(error => {
          console.error('Newsletter confirmation processing failed; pending work remains retryable.', error)
        })
      }

      return PUBLIC_ACCEPTED
    },

    async resendConfirmation(input) {
      const email = normalizeAndValidateEmail(input.email)
      const audienceKey = assertAudienceKey(input.audience ?? defaultAudience)
      await enforcePublicSecurity(
        'resend-confirmation',
        email,
        audienceKey,
        input.securityContext
      )

      const target = await config.storage.transaction(async transaction => {
        const contact = await transaction.getContactByEmail(email)
        if (contact == null || contact.status === CONTACT_STATUSES.SUPPRESSED) {
          return null
        }

        const subscription = await transaction.getSubscription(
          contact.id,
          audienceKey
        )
        if (
          subscription == null
          || subscription.status !== SUBSCRIPTION_STATUSES.PENDING_CONFIRMATION
        ) {
          return null
        }

        if (subscription.confirmationDelivery == null) {
          await transaction.updateSubscription(subscription.id, {
            confirmationDelivery: newConfirmationDelivery()
          })
        }

        return {
          contactId: contact.id,
          subscriptionId: subscription.id,
          lifecycleGeneration: subscription.lifecycleGeneration
        }
      })

      if (target != null) {
        await requestConfirmation(
          target.contactId,
          target.subscriptionId,
          target.lifecycleGeneration
        )
      }

      return PUBLIC_ACCEPTED
    },

    async confirm(input) {
      const resolvedAt = clock.now()
      const target = await config.capabilities.resolveConfirmation(input.token, resolvedAt)
      if (target == null) return NOT_CONFIRMED

      const result = await config.storage.transaction(async transaction => {
        const contact = await transaction.getContactById(target.contactId)
        const subscription = await transaction.getSubscriptionById(
          target.subscriptionId
        )

        if (
          contact == null
          || subscription == null
          || subscription.contactId !== contact.id
          || subscription.lifecycleGeneration !== target.lifecycleGeneration
          || contact.status === CONTACT_STATUSES.SUPPRESSED
          || subscription.status !== SUBSCRIPTION_STATUSES.PENDING_CONFIRMATION
        ) {
          return NOT_CONFIRMED
        }

        const now = clock.now()
        const currentTarget = await config.capabilities.resolveConfirmation(input.token, now)
        if (
          currentTarget?.contactId !== contact.id
          || currentTarget.subscriptionId !== subscription.id
          || currentTarget.lifecycleGeneration !== subscription.lifecycleGeneration
        ) return NOT_CONFIRMED

        await transaction.updateSubscription(subscription.id, {
          status: SUBSCRIPTION_STATUSES.ACTIVE,
          confirmationDelivery: null,
          confirmedAt: now,
          unsubscribedAt: null,
          updatedAt: now
        })
        await appendEvent(transaction, {
          contactId: contact.id,
          subscriptionId: subscription.id,
          type: NEWSLETTER_EVENT_TYPES.CONFIRMED,
          occurredAt: now,
          metadata: { audienceKey: subscription.audienceKey }
        })
        return CONFIRMED
      })

      // The serialized state transition is authoritative; cleanup follows commit
      // so a rolled-back transaction never burns the caller's confirmation token.
      if (result.confirmed) {
        await config.capabilities.consumeConfirmation(
          input.token,
          clock.now()
        ).catch(() => null)
      }
      return result
    },

    async unsubscribe(input) {
      const target = await config.capabilities.resolveUnsubscribeCapability(
        input.capability
      )
      if (target == null || target.scope !== 'SUBSCRIPTION') {
        return NOT_UNSUBSCRIBED
      }

      const result = await config.storage.transaction(async transaction => {
        const subscription = await transaction.getSubscriptionById(
          target.subscriptionId
        )
        if (
          subscription == null
          || subscription.contactId !== target.contactId
          || subscription.lifecycleGeneration !== target.lifecycleGeneration
        ) {
          return NOT_UNSUBSCRIBED
        }

        if (subscription.status === SUBSCRIPTION_STATUSES.UNSUBSCRIBED) {
          return UNSUBSCRIBED
        }

        const now = clock.now()
        await transaction.updateSubscription(subscription.id, {
          status: SUBSCRIPTION_STATUSES.UNSUBSCRIBED,
          confirmationDelivery: null,
          unsubscribedAt: now,
          updatedAt: now
        })
        await appendEvent(transaction, {
          contactId: target.contactId,
          subscriptionId: subscription.id,
          type: NEWSLETTER_EVENT_TYPES.UNSUBSCRIBED,
          occurredAt: now,
          metadata: { audienceKey: subscription.audienceKey }
        })
        return UNSUBSCRIBED
      })

      if (result.unsubscribed) {
        await config.capabilities.revokeConfirmations(
          target.subscriptionId,
          target.lifecycleGeneration
        ).catch(() => undefined)
      }
      return result
    },

    async unsubscribeAll(input) {
      const target = await config.capabilities.resolveUnsubscribeCapability(
        input.capability
      )
      if (target == null || target.scope !== 'ALL') {
        return NOT_UNSUBSCRIBED
      }

      const changed = await config.storage.transaction(async transaction => {
        const contact = await transaction.getContactById(target.contactId)
        if (
          contact == null
          || contact.capabilityGeneration !== target.capabilityGeneration
        ) return null

        const subscriptions = await transaction.listSubscriptions(contact.id)
        const changedSubscriptions: Subscription[] = []
        const now = clock.now()

        for (const subscription of subscriptions) {
          if (subscription.status === SUBSCRIPTION_STATUSES.UNSUBSCRIBED) {
            continue
          }

          await transaction.updateSubscription(subscription.id, {
            status: SUBSCRIPTION_STATUSES.UNSUBSCRIBED,
            confirmationDelivery: null,
            unsubscribedAt: now,
            updatedAt: now
          })
          await appendEvent(transaction, {
            contactId: contact.id,
            subscriptionId: subscription.id,
            type: NEWSLETTER_EVENT_TYPES.UNSUBSCRIBED,
            occurredAt: now,
            metadata: { audienceKey: subscription.audienceKey }
          })
          changedSubscriptions.push(subscription)
        }

        return changedSubscriptions
      })

      if (changed == null) return NOT_UNSUBSCRIBED
      await Promise.allSettled(
        changed.map(subscription =>
          config.capabilities.revokeConfirmations(
            subscription.id,
            subscription.lifecycleGeneration
          )
        )
      )
      return UNSUBSCRIBED
    },

    async createUnsubscribeCapability(input) {
      const email = normalizeAndValidateEmail(input.email)
      const audienceKey = assertAudienceKey(input.audience ?? defaultAudience)

      const target = await config.storage.transaction(async transaction => {
        const contact = await transaction.getContactByEmail(email)
        if (contact == null) return null

        if (input.all === true) {
          return {
            scope: 'ALL' as const,
            contactId: contact.id,
            capabilityGeneration: contact.capabilityGeneration
          }
        }

        const subscription = await transaction.getSubscription(
          contact.id,
          audienceKey
        )
        if (subscription == null) return null

        return {
          scope: 'SUBSCRIPTION' as const,
          contactId: contact.id,
          subscriptionId: subscription.id,
          lifecycleGeneration: subscription.lifecycleGeneration
        }
      })

      if (target == null) return null
      if (target.scope === 'ALL') {
        return config.capabilities.issueUnsubscribeAllCapability(target)
      }

      return config.capabilities.issueUnsubscribeCapability(target)
    },

    async cleanupConfirmationTokens(input = {}) {
      const retentionMs = input.retentionMs ?? cleanupRetentionMs
      if (!Number.isSafeInteger(retentionMs) || retentionMs < 0) {
        throw new NewsletterError(
          NEWSLETTER_ERROR_CODES.INVALID_CONFIGURATION,
          'cleanup retentionMs must be a non-negative safe integer.'
        )
      }
      return config.capabilities.cleanupConfirmations({
        deleteBefore: new Date(clock.now().getTime() - retentionMs)
      })
    },

    async getContact(input) {
      return config.storage.transaction(transaction =>
        resolveContact(transaction, input)
      )
    },

    async getSubscription(input: SubscriptionLookup) {
      return config.storage.transaction(async transaction => {
        if ('id' in input) {
          return transaction.getSubscriptionById(input.id)
        }

        const contact = await transaction.getContactByEmail(
          normalizeAndValidateEmail(input.email)
        )
        if (contact == null) return null
        return transaction.getSubscription(
          contact.id,
          assertAudienceKey(input.audience ?? defaultAudience)
        )
      })
    },

    async listSubscriptions(input) {
      return config.storage.transaction(async transaction => {
        const contact = await resolveContact(transaction, input)
        if (contact == null) return []
        return transaction.listSubscriptions(contact.id)
      })
    },

    async listEvents(input) {
      return config.storage.transaction(async transaction => {
        const contact = await resolveContact(transaction, input)
        if (contact == null) return []
        return transaction.listEvents(contact.id)
      })
    },

    async linkSubject(input) {
      const email = normalizeAndValidateEmail(input.email)
      return config.storage.transaction(async transaction => {
        const contact = await transaction.getContactByEmail(email)
        if (contact == null) return null
        if (subjectEquals(contact.subject, input.subject)) return contact

        if (contact.subject != null && input.replace !== true) {
          throw new NewsletterError(
            NEWSLETTER_ERROR_CODES.SUBJECT_CONFLICT,
            'The contact is already linked to a different external subject.'
          )
        }

        const now = clock.now()
        const updated = await transaction.updateContact(contact.id, {
          subject: input.subject,
          updatedAt: now
        })
        await appendEvent(transaction, {
          contactId: contact.id,
          type: NEWSLETTER_EVENT_TYPES.SUBJECT_LINKED,
          occurredAt: now,
          metadata: { namespace: input.subject.namespace }
        })
        return updated
      })
    },

    async suppressContact(input) {
      const email = normalizeAndValidateEmail(input.email)
      const reason = input.reason.trim()
      if (reason.length === 0) {
        throw new NewsletterError(
          NEWSLETTER_ERROR_CODES.INVALID_CONFIGURATION,
          'A suppression reason is required.'
        )
      }

      const transition = await config.storage.transaction(async transaction => {
        const contact = await transaction.getContactByEmail(email)
        if (contact == null) return null
        if (contact.status === CONTACT_STATUSES.SUPPRESSED) {
          return { contact, subscriptions: [] as Subscription[] }
        }

        const now = clock.now()
        const updated = await transaction.updateContact(contact.id, {
          status: CONTACT_STATUSES.SUPPRESSED,
          suppressedAt: now,
          suppressionReason: reason,
          updatedAt: now
        })
        await appendEvent(transaction, {
          contactId: contact.id,
          type: NEWSLETTER_EVENT_TYPES.SUPPRESSED,
          occurredAt: now,
          metadata: { reason }
        })
        const subscriptions = await transaction.listSubscriptions(contact.id)
        return {
          contact: updated,
          subscriptions
        }
      })

      if (transition == null) return null
      await Promise.allSettled(
        transition.subscriptions.map(subscription =>
          config.capabilities.revokeConfirmations(
            subscription.id,
            subscription.lifecycleGeneration
          )
        )
      )
      return transition.contact
    },

    async unsuppressContact(input) {
      const email = normalizeAndValidateEmail(input.email)
      return config.storage.transaction(async transaction => {
        const contact = await transaction.getContactByEmail(email)
        if (contact == null) return null
        if (contact.status === CONTACT_STATUSES.ENABLED) return contact

        const now = clock.now()
        const updated = await transaction.updateContact(contact.id, {
          status: CONTACT_STATUSES.ENABLED,
          suppressedAt: null,
          suppressionReason: null,
          updatedAt: now
        })
        await appendEvent(transaction, {
          contactId: contact.id,
          type: NEWSLETTER_EVENT_TYPES.UNSUPPRESSED,
          occurredAt: now
        })
        return updated
      })
    },

    async importSubscription(input) {
      assertImportShape(input)
      const email = normalizeAndValidateEmail(input.email)
      const audienceKey = assertAudienceKey(input.audience ?? defaultAudience)
      const createdAt = input.originalCreatedAt ?? input.consent.consentedAt
      const now = clock.now()

      return config.storage.transaction(async transaction => {
        let contact = await transaction.getContactByEmail(email)
        if (contact == null) {
          contact = await transaction.createContact({
            id: idGenerator.generate(),
            capabilityGeneration: 1,
            email,
            status: CONTACT_STATUSES.ENABLED,
            subject: input.subject ?? null,
            ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
            createdAt,
            updatedAt: now
          })
        } else if (input.subject !== undefined) {
          if (contact.subject == null) {
            contact = await transaction.updateContact(contact.id, {
              subject: input.subject,
              updatedAt: now
            })
            await appendEvent(transaction, {
              contactId: contact.id,
              type: NEWSLETTER_EVENT_TYPES.SUBJECT_LINKED,
              occurredAt: now,
              metadata: { namespace: input.subject.namespace }
            })
          } else if (!subjectEquals(contact.subject, input.subject)) {
            throw new NewsletterError(
              NEWSLETTER_ERROR_CODES.SUBJECT_CONFLICT,
              'The contact is already linked to a different external subject.'
            )
          }
        }

        const existing = await transaction.getSubscription(contact.id, audienceKey)
        if (existing != null) {
          if (importedSubscriptionMatches(existing, input, audienceKey)) {
            return existing
          }
          throw new NewsletterError(
            NEWSLETTER_ERROR_CODES.IMPORT_CONFLICT,
            'A different subscription already exists for this contact and audience.'
          )
        }

        const subscription = await transaction.createSubscription({
          id: idGenerator.generate(),
          lifecycleGeneration: 1,
          contactId: contact.id,
          audienceKey,
          status: input.status,
          consent: input.consent,
          confirmationDelivery: null,
          confirmationSentAt: null,
          confirmedAt: input.confirmedAt ?? null,
          unsubscribedAt: input.unsubscribedAt ?? null,
          createdAt,
          updatedAt: now
        })

        await appendEvent(transaction, {
          contactId: contact.id,
          subscriptionId: subscription.id,
          type: NEWSLETTER_EVENT_TYPES.IMPORTED,
          occurredAt: now,
          metadata: {
            audienceKey,
            status: input.status,
            consentVersion: input.consent.version,
            consentedAt: input.consent.consentedAt.toISOString(),
            ...(input.confirmedAt != null
              ? { confirmedAt: input.confirmedAt.toISOString() }
              : {}),
            ...(input.unsubscribedAt != null
              ? { unsubscribedAt: input.unsubscribedAt.toISOString() }
              : {})
          }
        })

        return subscription
      })
    }
  }

  return Object.freeze(service)
}
