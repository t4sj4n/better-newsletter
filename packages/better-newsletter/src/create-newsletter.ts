import { decodeEventCursor, encodeEventCursor, eventPageLimit } from './event-pagination.js'
import type {
  Clock,
  IdGenerator,
  BetterNewsletterOptions,
  BetterNewsletter
} from './config.js'
import {
  CONTACT_STATUSES,
  DELIVERY_FEEDBACK_TYPES,
  NEWSLETTER_EVENT_TYPES,
  SUBSCRIPTION_STATUSES,
  type ConfirmationDelivery,
  type ConsentEvidence,
  type Contact,
  type DeliveryFeedback,
  type ExternalSubject,
  type JsonValue,
  type NewsletterEventType,
  type Subscription
} from './domain.js'
import {
  NEWSLETTER_ERROR_CODES,
  NewsletterError,
  StorageConflictError
} from './errors.js'
import {
  MAIL_DELIVERY_FAILURES,
  MAIL_DELIVERY_REASONS,
  type MailDeliveryResult
} from './mailer.js'
import {
  assertAudienceKey,
  DEFAULT_AUDIENCE_KEY,
  normalizeAndValidateEmail
} from './normalize.js'
import type {
  ConfirmationState,
  ContactLookup,
  ImportSubscriptionInput,
  SubscriptionLookup,
  SubscribeInput
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
export const DEFAULT_TRANSACTION_MAX_ATTEMPTS = 3
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

/**
 * Compares consent version, source, locale, and the recorded consent timestamp.
 * Missing source/locale values match whether stored as null or undefined.
 */
function consentEquals(left: ConsentEvidence, right: ConsentEvidence): boolean {
  return left.version === right.version
    && (left.source ?? null) === (right.source ?? null)
    && (left.locale ?? null) === (right.locale ?? null)
    && left.consentedAt.getTime() === right.consentedAt.getTime()
}

function isStorageConflict(error: unknown): boolean {
  return error instanceof StorageConflictError
    || (error instanceof Error && error.name === 'StorageConflictError')
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
export function betterNewsletter(config: BetterNewsletterOptions): BetterNewsletter {
  return createNewsletterWithSubscriptionBatch(config).service
}

/** Internal integration helper; batch security runs before any lifecycle work. */
export function createNewsletterWithSubscriptionBatch(config: BetterNewsletterOptions) {
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
  const transactionMaxAttempts =
    config.transactionMaxAttempts ?? DEFAULT_TRANSACTION_MAX_ATTEMPTS

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
  if (!Number.isSafeInteger(transactionMaxAttempts) || transactionMaxAttempts <= 0) {
    throw new NewsletterError(
      NEWSLETTER_ERROR_CODES.INVALID_CONFIGURATION,
      'transactionMaxAttempts must be a positive safe integer.'
    )
  }
  const feedbackPolicy = config.feedbackPolicy ?? {}
  if (feedbackPolicy.softBounceThreshold !== undefined && (
    !Number.isSafeInteger(feedbackPolicy.softBounceThreshold)
    || feedbackPolicy.softBounceThreshold < 1
  )) {
    throw new NewsletterError(
      NEWSLETTER_ERROR_CODES.INVALID_CONFIGURATION,
      'feedbackPolicy.softBounceThreshold must be a positive safe integer.'
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
  const rateLimitChecks = [
    ...(config.rateLimitChecks ?? []),
    ...(config.rateLimiter != null && config.rateLimitKeyProvider != null
      ? [{ rateLimiter: config.rateLimiter, keyProvider: config.rateLimitKeyProvider, rateLimits: config.rateLimits }]
      : [])
  ]

  const clock = config.clock ?? systemClock
  const idGenerator = config.idGenerator ?? systemIdGenerator
  const tokenGenerator = config.tokenGenerator ?? secureTokenGenerator
  const logger = config.logger ?? console

  /** Runs a storage transaction, re-running the callback on storage conflicts. */
  const runTransaction = async <T>(
    operation: (transaction: NewsletterStorageTransaction) => Promise<T>
  ): Promise<T> => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await config.storage.transaction(operation)
      } catch (error) {
        if (!isStorageConflict(error) || attempt >= transactionMaxAttempts) {
          throw error
        }
      }
    }
  }

  const runInBackground = (task: Promise<void>): void => {
    const guarded = task.catch(error => {
      try {
        logger.error(
          'Newsletter confirmation processing failed; pending work remains retryable.',
          error
        )
      } catch {
        // A failing logger must not turn into an unhandled rejection.
      }
    })
    if (config.runBackground == null) return
    try {
      config.runBackground(guarded)
    } catch (error) {
      logger.error('The runBackground hook failed.', error)
    }
  }
  const newConfirmationDelivery = (): ConfirmationDelivery => ({
    id: idGenerator.generate(),
    attemptId: null,
    leaseExpiresAt: null
  })

  const enforcePublicSecurity = async (
    action: PublicAbuseAction,
    email: string,
    audienceKey: string,
    context: unknown,
    consumedKeys?: readonly Set<string>[]
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

    for (const [index, check] of rateLimitChecks.entries()) {
      const policy = action === 'subscribe'
        ? check.rateLimits?.subscribe ?? subscribeRateLimit
        : check.rateLimits?.resendConfirmation ?? resendRateLimit
      validateRatePolicy(`rateLimitChecks.${action}`, policy)
      const key = await check.keyProvider.createKey({
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
      if (consumedKeys?.[index]?.has(key)) continue
      const result = await check.rateLimiter.consume({
        key,
        action,
        limit: policy.limit,
        windowMs: policy.windowMs
      })
      if (!result.allowed) {
        throw new NewsletterError(
          NEWSLETTER_ERROR_CODES.RATE_LIMITED,
          'The request rate limit was exceeded.',
          result.retryAfterMs !== undefined
            ? { retryAfterMs: result.retryAfterMs }
            : {}
        )
      }
      consumedKeys?.[index]?.add(key)
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

  const resolveSubscription = async (
    transaction: NewsletterStorageTransaction,
    lookup: SubscriptionLookup
  ): Promise<Subscription | null> => {
    if ('id' in lookup) return transaction.getSubscriptionById(lookup.id)
    const contact = await resolveContact(transaction, { email: lookup.email })
    if (contact == null) return null
    return transaction.getSubscription(contact.id, assertAudienceKey(lookup.audience ?? defaultAudience))
  }

  // Resolve the contact hint separately so the authoritative transaction locks
  // contact before subscription, including for ID lookups. Recheck both rows.
  const confirmationTarget = async (lookup: SubscriptionLookup) => {
    return runTransaction(transaction => resolveSubscription(transaction, lookup))
  }

  const confirmationReason = (contact: Contact, subscription: Subscription): ConfirmationState['reason'] => {
    if (contact.status === CONTACT_STATUSES.SUPPRESSED) return 'SUPPRESSED'
    if (subscription.status === SUBSCRIPTION_STATUSES.ACTIVE) return 'ACTIVE'
    if (subscription.status === SUBSCRIPTION_STATUSES.UNSUBSCRIBED) return 'UNSUBSCRIBED'
    return null
  }

  const persistConfirmationToken = async (
    transaction: NewsletterStorageTransaction,
    subscription: Subscription,
    token: string,
    issuedAt: Date,
    expiresAt: Date
  ): Promise<void> => {
    const replacement = await config.capabilities.replaceConfirmation({
      token,
      contactId: subscription.contactId,
      subscriptionId: subscription.id,
      lifecycleGeneration: subscription.lifecycleGeneration,
      issuedAt,
      expiresAt,
      replacementStrategy,
      maxActiveTokens
    }, transaction.confirmationTokens)
    if (replacement != null) {
      for (const [type, count] of [
        [NEWSLETTER_EVENT_TYPES.CONFIRMATION_REPLACED, replacement.replacedCount],
        [NEWSLETTER_EVENT_TYPES.CONFIRMATION_EXPIRED, replacement.expiredCount]
      ] as const) {
        if (count > 0) {
          await appendEvent(transaction, {
            contactId: subscription.contactId, subscriptionId: subscription.id, type, occurredAt: issuedAt,
            metadata: { count, lifecycleGeneration: subscription.lifecycleGeneration }
          })
        }
      }
    }
  }

  const suppressionKeys = async (email: string): Promise<readonly string[]> => {
    if (config.suppressionKeyProvider == null) {
      throw new NewsletterError(
        NEWSLETTER_ERROR_CODES.INVALID_CONFIGURATION,
        'Suppression operations require a suppressionKeyProvider.'
      )
    }
    let derived: string | readonly string[]
    try {
      derived = await config.suppressionKeyProvider(email)
    } catch {
      throw new NewsletterError(
        NEWSLETTER_ERROR_CODES.INVALID_CONFIGURATION,
        'Suppression key derivation failed.'
      )
    }
    const keys = typeof derived === 'string' ? [derived] : derived
    if (!Array.isArray(keys) || keys.length === 0
      || keys.some(key => typeof key !== 'string' || !/^[a-f0-9]{64}$/u.test(key))
      || new Set(keys).size !== keys.length) {
      throw new NewsletterError(
        NEWSLETTER_ERROR_CODES.INVALID_CONFIGURATION,
        'Suppression keys must be distinct lowercase 64-character keyed digests.'
      )
    }
    return [...keys]
  }

  const suppressInTransaction = async (
    transaction: NewsletterStorageTransaction,
    contact: Contact,
    reason: string,
    now: Date
  ): Promise<Contact> => {
    if (contact.status === CONTACT_STATUSES.SUPPRESSED) return contact
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
    for (const subscription of await transaction.listSubscriptions(contact.id)) {
      await config.capabilities.revokeConfirmations(
        subscription.id,
        subscription.lifecycleGeneration,
        now,
        transaction.confirmationTokens
      )
    }
    return updated
  }

  const requestConfirmation = async (
    contactId: string,
    subscriptionId: string,
    lifecycleGeneration: number
  ): Promise<void> => {
    const attemptId = idGenerator.generate()

    const claim = await runTransaction(async transaction => {
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

      const claimed = await transaction.updateSubscription(subscriptionId, {
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

      return {
        contact,
        subscription: claimed,
        deliveryId: subscription.confirmationDelivery.id
      }
    })

    if (claim == null) return

    let result: MailDeliveryResult = { accepted: false }
    let stage = 'TOKEN_SETUP'
    try {
      const token = await tokenGenerator.generate()
      const issuedAt = clock.now()
      const expiresAt = new Date(issuedAt.getTime() + expiresInMs)

      const setup = await runTransaction(async transaction => {
        const contact = await transaction.getContactById(contactId)
        const current = await transaction.getSubscriptionById(subscriptionId)
        if (
          contact == null
          || current?.status !== SUBSCRIPTION_STATUSES.PENDING_CONFIRMATION
          || current.lifecycleGeneration !== lifecycleGeneration
          || current.confirmationDelivery?.attemptId !== attemptId
        ) return 'STALE' as const

        if (contact.status !== CONTACT_STATUSES.ENABLED) {
          // Release the claim so a resend after unsuppression is not blocked
          // until the lease expires.
          await transaction.updateSubscription(subscriptionId, {
            confirmationDelivery: {
              ...current.confirmationDelivery,
              attemptId: null,
              leaseExpiresAt: null
            },
            updatedAt: issuedAt
          })
          await appendEvent(transaction, {
            contactId,
            subscriptionId,
            type: NEWSLETTER_EVENT_TYPES.CONFIRMATION_SEND_FAILED,
            occurredAt: issuedAt,
            metadata: {
              deliveryId: claim.deliveryId,
              attemptId,
              lifecycleGeneration,
              authoritative: true,
              stage: 'ELIGIBILITY',
              reason: 'CONTACT_SUPPRESSED'
            }
          })
          return 'INELIGIBLE' as const
        }

        // Fence token replacement as well as completion: a stale worker must
        // never replace tokens belonging to a newer delivery attempt.
        await persistConfirmationToken(transaction, current, token, issuedAt, expiresAt)
        return 'READY' as const
      })
      if (setup !== 'READY') return

      stage = 'DELIVERY'
      result = await config.mailer.sendConfirmation({
        contact: claim.contact,
        subscription: claim.subscription,
        token,
        expiresAt,
        deliveryId: claim.deliveryId,
        attemptId,
        audienceKey: claim.subscription.audienceKey,
        lifecycleGeneration
      })
    } catch {
      result = stage === 'DELIVERY'
        ? { accepted: false, failure: MAIL_DELIVERY_FAILURES.AMBIGUOUS, reason: MAIL_DELIVERY_REASONS.UNKNOWN }
        : { accepted: false, failure: MAIL_DELIVERY_FAILURES.TEMPORARY, reason: MAIL_DELIVERY_REASONS.TOKEN_SETUP_FAILED }
    }

    const failure = result.accepted
      ? null
      : result.failure ?? MAIL_DELIVERY_FAILURES.TEMPORARY
    const reason = !result.accepted && result.reason !== undefined
      ? Object.values(MAIL_DELIVERY_REASONS).some(code => code === result.reason)
        ? result.reason
        : MAIL_DELIVERY_REASONS.UNKNOWN
      : undefined
    const completedAt = clock.now()
    await runTransaction(async transaction => {
      const current = await transaction.getSubscriptionById(subscriptionId)
      if (current == null) return

      // Only the attempt that still owns the current work may finalize it.
      // A superseded attempt records its result under a distinct event type.
      const authoritative = current.lifecycleGeneration === lifecycleGeneration
        && current.status === SUBSCRIPTION_STATUSES.PENDING_CONFIRMATION
        && current.confirmationDelivery?.attemptId === attemptId

      if (
        authoritative
        // An ambiguous send keeps its claim until the lease expires, so an
        // immediate retry cannot add another message while it may be in flight.
        && failure !== MAIL_DELIVERY_FAILURES.AMBIGUOUS
      ) {
        await transaction.updateSubscription(subscriptionId, {
          ...(failure == null ? { confirmationSentAt: completedAt } : {}),
          confirmationDelivery: failure === MAIL_DELIVERY_FAILURES.TEMPORARY
            ? { ...current.confirmationDelivery!, attemptId: null, leaseExpiresAt: null }
            : null,
          updatedAt: completedAt
        })
      }

      await appendEvent(transaction, {
        contactId,
        subscriptionId,
        type: !authoritative
          ? NEWSLETTER_EVENT_TYPES.CONFIRMATION_STALE_RESULT
          : failure == null
            ? NEWSLETTER_EVENT_TYPES.CONFIRMATION_SENT
            : NEWSLETTER_EVENT_TYPES.CONFIRMATION_SEND_FAILED,
        occurredAt: completedAt,
        metadata: {
          deliveryId: claim.deliveryId,
          attemptId,
          lifecycleGeneration,
          authoritative,
          outcome: failure ?? 'ACCEPTED',
          ...(failure != null ? { stage } : {}),
          ...(result.providerMessageId !== undefined
            ? { providerMessageId: result.providerMessageId }
            : {}),
          ...(reason !== undefined
            ? { reason }
            : {})
        }
      })
    })
  }

  const subscribe = async (input: SubscribeInput, securityChecked = false) => {
    const email = normalizeAndValidateEmail(input.email)
    const audienceKey = assertAudienceKey(input.audience ?? defaultAudience)
    const now = clock.now()
    const consent = consentFromPublicInput(input.consent, now)
    const keys = config.suppressionKeyProvider == null ? [] : await suppressionKeys(email)
    if (!securityChecked) await enforcePublicSecurity(
      'subscribe',
      email,
      audienceKey,
      input.securityContext
    )

    const transition = await runTransaction(async transaction => {
      for (const key of keys) {
        if (await transaction.hasSuppressionKey(key)) return null
      }
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

    if (transition?.shouldSend) {
      runInBackground(requestConfirmation(
        transition.contact.id,
        transition.subscription.id,
        transition.subscription.lifecycleGeneration
      ))
    }

    return PUBLIC_ACCEPTED
  }

  const service: BetterNewsletter = {
    async processFeedback(input: DeliveryFeedback) {
      const email = normalizeAndValidateEmail(input.email)
      const provider = input.provider.trim()
      const providerEventId = input.providerEventId?.trim()
      if (
        provider.length === 0 || provider.length > 128
        || (providerEventId !== undefined && (providerEventId.length === 0 || providerEventId.length > 255))
        || !Object.values(DELIVERY_FEEDBACK_TYPES).includes(input.type)
        || !(input.occurredAt instanceof Date)
        || Number.isNaN(input.occurredAt.getTime())
      ) {
        throw new NewsletterError(
          NEWSLETTER_ERROR_CODES.INVALID_CONFIGURATION,
          'Invalid normalized delivery feedback.'
        )
      }
      return runTransaction(async transaction => {
        const contact = await transaction.getContactByEmail(email)
        if (contact == null) return { processed: false, suppressed: false }
        if (providerEventId !== undefined && !await transaction.claimProviderEvent(
          provider, providerEventId, contact.id
        )) {
          return { processed: false, suppressed: contact.status === CONTACT_STATUSES.SUPPRESSED }
        }
        const now = clock.now()
        await appendEvent(transaction, {
          contactId: contact.id,
          type: NEWSLETTER_EVENT_TYPES.PROVIDER_FEEDBACK,
          occurredAt: now,
          metadata: {
            provider,
            feedbackType: input.type,
            feedbackOccurredAt: input.occurredAt.toISOString(),
            ...(providerEventId === undefined ? {} : { providerEventId })
          }
        })
        const unsuppressedAt = await transaction.latestUnsuppressedAt(contact.id)
        const stale = unsuppressedAt != null && input.occurredAt <= unsuppressedAt
        let suppress = (
          input.type === DELIVERY_FEEDBACK_TYPES.COMPLAINT
            && feedbackPolicy.suppressOnComplaint !== false
        ) || (
          input.type === DELIVERY_FEEDBACK_TYPES.HARD_BOUNCE
            && feedbackPolicy.suppressOnHardBounce !== false
        ) || (
          input.type === DELIVERY_FEEDBACK_TYPES.PROVIDER_SUPPRESSION
            && feedbackPolicy.suppressOnProviderSuppression !== false
        )
        if (stale) suppress = false
        if (!stale && input.type === DELIVERY_FEEDBACK_TYPES.SOFT_BOUNCE
          && feedbackPolicy.softBounceThreshold !== undefined) {
          const count = await transaction.countSoftBouncesAfter(
            contact.id,
            unsuppressedAt,
            feedbackPolicy.softBounceThreshold
          )
          suppress = count >= feedbackPolicy.softBounceThreshold
        }
        const updated = suppress
          ? await suppressInTransaction(transaction, contact, `provider:${provider}:${input.type}`, now)
          : contact
        return { processed: true, suppressed: updated.status === CONTACT_STATUSES.SUPPRESSED }
      })
    },
    subscribe(input) {
      return subscribe(input)
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

      const target = await runTransaction(async transaction => {
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

      // Deliver in the background like signup, so neither response time nor
      // delivery errors reveal whether the address has pending work.
      if (target != null) {
        runInBackground(requestConfirmation(
          target.contactId,
          target.subscriptionId,
          target.lifecycleGeneration
        ))
      }

      return PUBLIC_ACCEPTED
    },

    async createConfirmationToken(input) {
      const hint = await confirmationTarget(input.subscription)
      if (hint == null) return null
      return runTransaction(async transaction => {
        const contact = await transaction.getContactById(hint.contactId)
        const subscription = await transaction.getSubscriptionById(hint.id)
        if (contact == null || subscription == null || subscription.contactId !== contact.id
          || confirmationReason(contact, subscription) != null) return null
        const token = await tokenGenerator.generate()
        const issuedAt = clock.now()
        const expiresAt = new Date(issuedAt.getTime() + expiresInMs)
        await persistConfirmationToken(transaction, subscription, token, issuedAt, expiresAt)
        await appendEvent(transaction, {
          contactId: contact.id,
          subscriptionId: subscription.id,
          type: NEWSLETTER_EVENT_TYPES.CONFIRMATION_TOKEN_CREATED,
          occurredAt: issuedAt,
          metadata: {
            ...input.eventMetadata,
            audienceKey: subscription.audienceKey,
            lifecycleGeneration: subscription.lifecycleGeneration
          }
        })
        return { token, expiresAt }
      })
    },

    async getConfirmationState(input) {
      const hint = await confirmationTarget(input.subscription)
      if (hint == null) return null
      return runTransaction(async transaction => {
        const contact = await transaction.getContactById(hint.contactId)
        const subscription = await transaction.getSubscriptionById(hint.id)
        if (contact == null || subscription == null || subscription.contactId !== contact.id) return null
        const reason = confirmationReason(contact, subscription)
        const activeTokenExpiresAt = reason == null
          ? await transaction.getLatestUsableConfirmationExpiry({
            subscriptionId: subscription.id,
            lifecycleGeneration: subscription.lifecycleGeneration,
            now: clock.now()
          })
          : null
        return { canCreate: reason == null, reason, activeTokenExpiresAt }
      })
    },

    async confirm(input) {
      return runTransaction(async transaction => {
        const now = clock.now()
        const target = await config.capabilities.resolveConfirmation(
          input.token,
          now,
          transaction.confirmationTokens
        )
        if (target == null) return NOT_CONFIRMED

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

        // Consumption shares the transaction, so a rolled-back activation
        // never burns the caller's confirmation token.
        const consumed = await config.capabilities.consumeConfirmation(
          input.token,
          now,
          transaction.confirmationTokens
        )
        if (
          consumed?.contactId !== contact.id
          || consumed.subscriptionId !== subscription.id
          || consumed.lifecycleGeneration !== subscription.lifecycleGeneration
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
    },

    async unsubscribe(input) {
      const target = await config.capabilities.resolveUnsubscribeCapability(
        input.capability
      )
      if (target == null || target.scope !== 'SUBSCRIPTION') {
        return NOT_UNSUBSCRIBED
      }

      return runTransaction(async transaction => {
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
        await config.capabilities.revokeConfirmations(
          subscription.id,
          subscription.lifecycleGeneration,
          now,
          transaction.confirmationTokens
        )
        return UNSUBSCRIBED
      })
    },

    async unsubscribeAll(input) {
      const target = await config.capabilities.resolveUnsubscribeCapability(
        input.capability
      )
      if (target == null || target.scope !== 'ALL') {
        return NOT_UNSUBSCRIBED
      }

      return runTransaction(async transaction => {
        const contact = await transaction.getContactById(target.contactId)
        if (
          contact == null
          || contact.capabilityGeneration !== target.capabilityGeneration
        ) return NOT_UNSUBSCRIBED

        const subscriptions = await transaction.listSubscriptions(contact.id)
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
          await config.capabilities.revokeConfirmations(
            subscription.id,
            subscription.lifecycleGeneration,
            now,
            transaction.confirmationTokens
          )
        }

        return UNSUBSCRIBED
      })
    },

    async createUnsubscribeCapability(input) {
      const email = normalizeAndValidateEmail(input.email)
      const audienceKey = assertAudienceKey(input.audience ?? defaultAudience)

      const target = await runTransaction(async transaction => {
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

    async createManagePreferencesCapability(input) {
      const contact = await runTransaction(transaction =>
        resolveContact(transaction, input)
      )
      if (contact == null) return null
      return config.capabilities.issueManagePreferencesCapability({
        contactId: contact.id,
        capabilityGeneration: contact.capabilityGeneration
      })
    },

    async listPreferences(input) {
      const target = await config.capabilities.resolveUnsubscribeCapability(
        input.capability
      )
      if (target == null || target.scope !== 'MANAGE') return null
      const subscriptions = await runTransaction(async transaction => {
        const contact = await transaction.getContactById(target.contactId)
        if (contact?.capabilityGeneration !== target.capabilityGeneration) {
          return null
        }
        return transaction.listSubscriptions(contact.id)
      })
      if (subscriptions == null) return null
      return Promise.all(subscriptions.map(async subscription => ({
        audience: subscription.audienceKey,
        status: subscription.status,
        unsubscribeCapability: await config.capabilities.issueUnsubscribeCapability({
          contactId: target.contactId,
          subscriptionId: subscription.id,
          lifecycleGeneration: subscription.lifecycleGeneration
        })
      })))
    },

    async cleanupConfirmationTokens(input = {}) {
      const retentionMs = input.retentionMs ?? cleanupRetentionMs
      if (!Number.isSafeInteger(retentionMs) || retentionMs < 0) {
        throw new NewsletterError(
          NEWSLETTER_ERROR_CODES.INVALID_CONFIGURATION,
          'cleanup retentionMs must be a non-negative safe integer.'
        )
      }
      const deleteBefore = new Date(clock.now().getTime() - retentionMs)
      return runTransaction(transaction =>
        config.capabilities.cleanupConfirmations(
          { deleteBefore },
          transaction.confirmationTokens
        )
      )
    },

    async getContact(input) {
      return runTransaction(transaction =>
        resolveContact(transaction, input)
      )
    },

    async getSubscription(input: SubscriptionLookup) {
      return runTransaction(transaction => resolveSubscription(transaction, input))
    },

    async listSubscriptions(input) {
      return runTransaction(async transaction => {
        const contact = await resolveContact(transaction, input)
        if (contact == null) return []
        return transaction.listSubscriptions(contact.id)
      })
    },

    async listEvents(input) {
      return runTransaction(async transaction => {
        const contact = await resolveContact(transaction, input)
        if (contact == null) return []
        return transaction.listEvents(contact.id)
      })
    },

    async listSubscriptionEvents(input) {
      const limit = eventPageLimit(input.limit)
      const cursor = input.cursor === undefined ? null : decodeEventCursor(input.cursor)
      return runTransaction(async transaction => {
        const subscription = await resolveSubscription(transaction, input.subscription)
        if (subscription == null) return { events: [], nextCursor: null }
        if (cursor != null && cursor.subscriptionId !== subscription.id) {
          throw new NewsletterError(NEWSLETTER_ERROR_CODES.INVALID_PAGINATION, 'Cursor does not match the subscription.')
        }
        const rows = await transaction.listSubscriptionEvents({
          subscriptionId: subscription.id,
          ...(cursor == null ? {} : { beforeSequence: cursor.sequence }),
          limit: limit + 1
        })
        const page = rows.slice(0, limit)
        return {
          events: page.map(row => row.event),
          nextCursor: rows.length > limit
            ? encodeEventCursor(subscription.id, page[page.length - 1]!.sequence)
            : null
        }
      })
    },

    async exportContactData(input) {
      return runTransaction(async transaction => {
        const contact = await resolveContact(transaction, input)
        if (contact == null) return null
        const [subscriptions, events, confirmationTokens] = await Promise.all([
          transaction.listSubscriptions(contact.id),
          transaction.listEvents(contact.id),
          transaction.listContactTokenMetadata(contact.id)
        ])
        return { contact, subscriptions, events, confirmationTokens }
      })
    },

    async eraseContactData(input) {
      if (input.strategy !== 'DELETE' && input.strategy !== 'ANONYMIZE') {
        throw new NewsletterError(NEWSLETTER_ERROR_CODES.INVALID_CONFIGURATION, 'Invalid erasure strategy.')
      }
      if (input.suppression !== undefined
        && input.suppression !== 'NONE'
        && input.suppression !== 'RETAIN_HASH') {
        throw new NewsletterError(NEWSLETTER_ERROR_CODES.INVALID_CONFIGURATION, 'Invalid suppression policy.')
      }
      if (input.suppression === 'RETAIN_HASH' && config.suppressionKeyProvider == null) {
        throw new NewsletterError(
          NEWSLETTER_ERROR_CODES.INVALID_CONFIGURATION,
          'RETAIN_HASH requires a suppressionKeyProvider.'
        )
      }
      for (let attempt = 1; attempt <= transactionMaxAttempts; attempt += 1) {
        let expectedEmail: string | null = null
        let retainedKeys: readonly string[] = []
        if (input.suppression === 'RETAIN_HASH') {
          if ('email' in input.contact) {
            expectedEmail = normalizeAndValidateEmail(input.contact.email)
          } else {
            const contactId = input.contact.id
            const initial = await runTransaction(transaction => transaction.getContactById(contactId))
            if (initial == null) return { erased: false }
            expectedEmail = initial.email
          }
          if (!/^erased-[0-9a-f-]+@erased\.invalid$/u.test(expectedEmail)) {
            retainedKeys = await suppressionKeys(expectedEmail)
          }
        }
        const result = await runTransaction(async transaction => {
          const contact = await resolveContact(transaction, input.contact)
          if (contact == null) return { erased: false, retry: false }
          if (expectedEmail != null && contact.email !== expectedEmail) {
            return { erased: false, retry: true }
          }
          if (/^erased-[0-9a-f-]+@erased\.invalid$/u.test(contact.email)) {
            if (input.strategy === 'ANONYMIZE') return { erased: false, retry: false }
            if (input.suppression === 'RETAIN_HASH') {
              throw new NewsletterError(
                NEWSLETTER_ERROR_CODES.INVALID_CONFIGURATION,
                'The original e-mail is unavailable for a suppression hash.'
              )
            }
            await transaction.deleteContact(contact.id)
            return { erased: true, retry: false }
          }
          if (input.suppression === 'RETAIN_HASH') {
            await transaction.retainSuppressionKey(retainedKeys[0]!)
          }
          await transaction.deleteContactTokens(contact.id)
          if (input.strategy === 'DELETE') {
            await transaction.deleteContact(contact.id)
            return { erased: true, retry: false }
          }

          const now = clock.now()
          const subscriptions = await transaction.listSubscriptions(contact.id)
          await transaction.deleteProviderEvents(contact.id)
          await transaction.minimizeEvents(contact.id)
          for (const subscription of subscriptions) {
            await transaction.updateSubscription(subscription.id, {
              audienceKey: `erased-${crypto.randomUUID()}`,
              lifecycleGeneration: nextGeneration(subscription.lifecycleGeneration),
              status: SUBSCRIPTION_STATUSES.UNSUBSCRIBED,
              consent: { version: '[erased]', consentedAt: subscription.consent.consentedAt },
              confirmationDelivery: null,
              confirmationSentAt: null,
              unsubscribedAt: now,
              updatedAt: now
            })
          }
          await transaction.updateContact(contact.id, {
            email: `erased-${crypto.randomUUID()}@erased.invalid`,
            capabilityGeneration: nextGeneration(contact.capabilityGeneration),
            subject: null,
            metadata: {},
            status: CONTACT_STATUSES.SUPPRESSED,
            suppressedAt: now,
            suppressionReason: null,
            updatedAt: now
          })
          return { erased: true, retry: false }
        })
        if (!result.retry) return { erased: result.erased }
      }
      throw new StorageConflictError('Contact changed during erasure.')
    },

    async removeRetainedSuppression(input) {
      const email = normalizeAndValidateEmail(input.email)
      const keys = await suppressionKeys(email)
      return runTransaction(async transaction => {
        let removed = false
        for (const key of keys) {
          removed = await transaction.removeSuppressionKey(key) || removed
        }
        return { removed }
      })
    },

    async linkSubject(input) {
      const email = normalizeAndValidateEmail(input.email)
      return runTransaction(async transaction => {
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

      return runTransaction(async transaction => {
        const contact = await transaction.getContactByEmail(email)
        if (contact == null) return null
        return suppressInTransaction(transaction, contact, reason, clock.now())
      })
    },

    async unsuppressContact(input) {
      const email = normalizeAndValidateEmail(input.email)
      return runTransaction(async transaction => {
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

      return runTransaction(async transaction => {
        let contact = await transaction.getContactByEmail(email)
        const contactCreated = contact == null
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

        // A new audience extends the contact's scope, so older
        // unsubscribe-all links must not cover it.
        if (!contactCreated) {
          contact = await transaction.updateContact(contact.id, {
            capabilityGeneration: nextGeneration(contact.capabilityGeneration),
            updatedAt: now
          })
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

  return {
    service: Object.freeze(service),
    async subscribeMany(inputs: readonly SubscribeInput[]) {
      const consumedKeys = rateLimitChecks.map(() => new Set<string>())
      for (const input of inputs) {
        const email = normalizeAndValidateEmail(input.email)
        const audience = assertAudienceKey(input.audience ?? defaultAudience)
        consentFromPublicInput(input.consent, clock.now())
        await enforcePublicSecurity('subscribe', email, audience, input.securityContext, consumedKeys)
      }
      for (const input of inputs) await subscribe(input, true)
      return PUBLIC_ACCEPTED
    }
  }
}
