import type { TokenGenerator } from './config.js'
import {
  NEWSLETTER_ERROR_CODES,
  NewsletterError
} from './errors.js'
import type {
  ConfirmationReplacementResult,
  NewsletterCapabilities,
  UnsubscribeCapabilityTarget
} from './capabilities.js'

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

export const CONFIRMATION_REPLACEMENT_STRATEGIES = {
  REPLACE_PREVIOUS: 'REPLACE_PREVIOUS',
  RETAIN_PREVIOUS_UNTIL_EXPIRY: 'RETAIN_PREVIOUS_UNTIL_EXPIRY'
} as const

export type ConfirmationReplacementStrategy =
  typeof CONFIRMATION_REPLACEMENT_STRATEGIES[
    keyof typeof CONFIRMATION_REPLACEMENT_STRATEGIES
  ]

function assertConfirmationReplacementStrategy(
  value: unknown
): asserts value is ConfirmationReplacementStrategy {
  if (
    value !== CONFIRMATION_REPLACEMENT_STRATEGIES.REPLACE_PREVIOUS
    && value !== CONFIRMATION_REPLACEMENT_STRATEGIES.RETAIN_PREVIOUS_UNTIL_EXPIRY
  ) {
    throw new NewsletterError(
      NEWSLETTER_ERROR_CODES.INVALID_CONFIGURATION,
      'Invalid confirmation replacement strategy.'
    )
  }
}

export const CAPABILITY_PURPOSES = {
  CONFIRMATION: 'CONFIRMATION',
  UNSUBSCRIBE: 'UNSUBSCRIBE',
  UNSUBSCRIBE_ALL: 'UNSUBSCRIBE_ALL',
  MANAGE_PREFERENCES: 'MANAGE_PREFERENCES'
} as const

export type CapabilityPurpose =
  typeof CAPABILITY_PURPOSES[keyof typeof CAPABILITY_PURPOSES]

export type PublicAbuseAction = 'subscribe' | 'resend-confirmation'

export interface AbuseGuard {
  verify(input: {
    readonly action: PublicAbuseAction
    readonly email: string
    readonly audienceKey: string
    readonly context?: unknown
  }): Promise<{ readonly allowed: boolean }>
}

export interface RateLimitPolicy {
  readonly limit: number
  readonly windowMs: number
}

export interface RateLimiter {
  consume(input: {
    readonly key: string
    readonly action: PublicAbuseAction
    readonly limit: number
    readonly windowMs: number
  }): Promise<{
    readonly allowed: boolean
    readonly retryAfterMs?: number
  }>
}

export interface RateLimitKeyProvider {
  createKey(input: {
    readonly action: PublicAbuseAction
    readonly email: string
    readonly audienceKey: string
    readonly context?: unknown
  }): Promise<string>
}

export interface ConfirmationTokenRecord {
  readonly digest: string
  readonly purpose: 'CONFIRMATION'
  readonly contactId: string
  readonly subscriptionId: string
  readonly lifecycleGeneration: number
  readonly createdAt: Date
  readonly expiresAt: Date
  readonly consumedAt?: Date | null
  readonly revokedAt?: Date | null
}

export interface ConfirmationTokenStore {
  /**
   * Atomically apply retention within subscriptionId + lifecycleGeneration.
   * Keep newest records first, using insertion order to break timestamp ties.
   */
  replace(input: {
    readonly record: ConfirmationTokenRecord
    readonly strategy: ConfirmationReplacementStrategy
    readonly maxActiveTokens: number
    readonly now: Date
  }): Promise<ConfirmationReplacementResult>

  resolve(input: {
    readonly digest: string
    readonly now: Date
  }): Promise<ConfirmationTokenRecord | null>

  consume(input: {
    readonly digest: string
    readonly now: Date
  }): Promise<ConfirmationTokenRecord | null>

  revokeBySubscription(input: {
    readonly subscriptionId: string
    readonly lifecycleGeneration: number
    readonly now: Date
  }): Promise<number>

  cleanup(input: {
    readonly deleteBefore: Date
  }): Promise<number>
}

type VersionedSecret = {
  readonly version: number
  readonly value: string | Uint8Array
}

export type SecureCapabilitiesOptions = {
  readonly hmacSecret: string | Uint8Array
  readonly secrets?: readonly VersionedSecret[]
  /** Only for the first rolling bn2-to-bn3 deployment. */
  readonly issueLegacyCapabilities?: boolean
} | {
  readonly hmacSecret?: string | Uint8Array
  readonly secrets: readonly VersionedSecret[]
  /** Requires hmacSecret as well as secrets. */
  readonly issueLegacyCapabilities?: boolean
}

export interface HmacRateLimitKeyProviderOptions {
  readonly secret: string | Uint8Array
  readonly material?: (input: {
    readonly action: PublicAbuseAction
    readonly email: string
    readonly audienceKey: string
    readonly context?: unknown
  }) => string
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

function bytesToHex(bytes: Uint8Array): string {
  let output = ''
  for (const byte of bytes) output += byte.toString(16).padStart(2, '0')
  return output
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '')
}

function stringToBase64Url(value: string): string {
  return bytesToBase64Url(textEncoder.encode(value))
}

function base64UrlToBytes(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return null
  const padded = value.replaceAll('-', '+').replaceAll('_', '/')
    + '='.repeat((4 - value.length % 4) % 4)
  try {
    const binary = atob(padded)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index)
    }
    return bytes
  } catch {
    return null
  }
}

function base64UrlToString(value: string): string | null {
  const bytes = base64UrlToBytes(value)
  if (bytes == null) return null
  try {
    return textDecoder.decode(bytes)
  } catch {
    return null
  }
}

function secretBytes(secret: string | Uint8Array): Uint8Array {
  if (typeof secret !== 'string' && !(secret instanceof Uint8Array)) {
    throw new NewsletterError(
      NEWSLETTER_ERROR_CODES.INVALID_CONFIGURATION,
      'HMAC secrets must contain at least 32 bytes.'
    )
  }
  const bytes = typeof secret === 'string'
    ? textEncoder.encode(secret)
    : new Uint8Array(secret)

  if (bytes.byteLength < 32) {
    throw new NewsletterError(
      NEWSLETTER_ERROR_CODES.INVALID_CONFIGURATION,
      'HMAC secrets must contain at least 32 bytes.'
    )
  }
  return bytes
}

/**
 * Validates the secret synchronously so misconfiguration throws from the
 * factory instead of surfacing later as an unhandled rejection.
 */
function importHmacKey(
  secret: string | Uint8Array,
  usages: readonly KeyUsage[]
): Promise<CryptoKey> {
  const bytes = secretBytes(secret)
  const key = crypto.subtle.importKey(
    'raw',
    toArrayBuffer(bytes),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    [...usages]
  )
  // Consumers await the key and still observe a failure; this only prevents
  // an unhandled rejection before the first use.
  key.catch(() => undefined)
  return key
}

async function signHmac(key: CryptoKey, payload: string): Promise<string> {
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    textEncoder.encode(payload)
  )
  return bytesToBase64Url(new Uint8Array(signature))
}

async function verifyHmac(
  key: CryptoKey,
  payload: string,
  signature: string
): Promise<boolean> {
  const signatureBytes = base64UrlToBytes(signature)
  if (signatureBytes == null) return false
  return crypto.subtle.verify(
    'HMAC',
    key,
    toArrayBuffer(signatureBytes),
    textEncoder.encode(payload)
  )
}

export const secureTokenGenerator: TokenGenerator = Object.freeze({
  generate(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(32))
    return bytesToHex(bytes)
  }
})

export async function sha256Digest(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    textEncoder.encode(value)
  )
  return bytesToHex(new Uint8Array(digest))
}

function capabilityPayload(
  target: UnsubscribeCapabilityTarget,
  keyVersion: number | undefined
): string {
  const generation = target.scope === 'SUBSCRIPTION'
    ? target.lifecycleGeneration
    : target.capabilityGeneration
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new NewsletterError(
      NEWSLETTER_ERROR_CODES.INVALID_CONFIGURATION,
      'Capability generations must be positive safe integers.'
    )
  }
  return [
    keyVersion == null ? 'bn2' : 'bn3',
    ...(keyVersion == null ? [] : [String(keyVersion)]),
    target.scope === 'SUBSCRIPTION' ? 'u' : target.scope === 'MANAGE' ? 'm' : 'a',
    stringToBase64Url(target.contactId),
    stringToBase64Url(
      target.scope === 'SUBSCRIPTION' ? target.subscriptionId : target.contactId
    ),
    String(generation)
  ].join('.')
}

function parseCapability(capability: string): {
  target: UnsubscribeCapabilityTarget
  payload: string
  signature: string
  keyVersion: number | undefined
} | null {
  const parts = capability.split('.')
  const versioned = parts[0] === 'bn3' && parts.length === 7
  if (!versioned && (parts[0] !== 'bn2' || parts.length !== 6)) return null
  const keyVersionText = versioned ? parts[1]! : undefined
  const keyVersion = keyVersionText == null ? undefined : Number(keyVersionText)
  if (keyVersionText != null && (
    !/^(0|[1-9][0-9]*)$/u.test(keyVersionText)
    || !Number.isSafeInteger(keyVersion)
  )) return null
  const offset = versioned ? 1 : 0
  const code = parts[1 + offset]
  if (code !== 'u' && code !== 'a' && code !== 'm') return null

  const contactId = base64UrlToString(parts[2 + offset]!)
  const targetId = base64UrlToString(parts[3 + offset]!)
  const generation = Number(parts[4 + offset])
  if (
    contactId == null || contactId.length === 0
    || targetId == null || targetId.length === 0
    || !/^[1-9][0-9]*$/u.test(parts[4 + offset]!)
    || !Number.isSafeInteger(generation)
    || (code !== 'u' && targetId !== contactId)
  ) {
    return null
  }

  return {
    target: code === 'u'
      ? { scope: 'SUBSCRIPTION', contactId, subscriptionId: targetId, lifecycleGeneration: generation }
      : { scope: code === 'm' ? 'MANAGE' : 'ALL', contactId, capabilityGeneration: generation },
    payload: parts.slice(0, 5 + offset).join('.'),
    signature: parts[5 + offset]!,
    keyVersion
  }
}

export function createSecureCapabilities(
  options: SecureCapabilitiesOptions
): NewsletterCapabilities {
  if (options.issueLegacyCapabilities === true && (
    options.hmacSecret == null || options.secrets == null
  )) {
    throw new NewsletterError(
      NEWSLETTER_ERROR_CODES.INVALID_CONFIGURATION,
      'Legacy issuance requires both hmacSecret and versioned secrets.'
    )
  }
  const legacyKey = options.hmacSecret == null
    ? undefined
    : importHmacKey(options.hmacSecret, ['sign', 'verify'])
  const versionedKeys = new Map<number, Promise<CryptoKey>>()
  if (options.secrets !== undefined) {
    if (!Array.isArray(options.secrets) || options.secrets.length === 0) {
      throw new NewsletterError(
        NEWSLETTER_ERROR_CODES.INVALID_CONFIGURATION,
        'At least one versioned HMAC secret is required.'
      )
    }
    for (const entry of options.secrets) {
      if (
        entry == null || !Number.isSafeInteger(entry.version)
        || entry.version < 0 || versionedKeys.has(entry.version)
      ) {
        throw new NewsletterError(
          NEWSLETTER_ERROR_CODES.INVALID_CONFIGURATION,
          'HMAC secret versions must be unique non-negative safe integers.'
        )
      }
      versionedKeys.set(entry.version, importHmacKey(entry.value, ['sign', 'verify']))
    }
  }
  if (legacyKey == null && versionedKeys.size === 0) {
    throw new NewsletterError(
      NEWSLETTER_ERROR_CODES.INVALID_CONFIGURATION,
      'An HMAC secret is required.'
    )
  }
  const currentVersion = options.issueLegacyCapabilities === true
    ? undefined
    : options.secrets?.[0]?.version
  const signingKey = currentVersion == null ? legacyKey! : versionedKeys.get(currentVersion)!

  const issueSignedCapability = async (
    target: UnsubscribeCapabilityTarget
  ): Promise<string> => {
    const payload = capabilityPayload(target, currentVersion)
    return `${payload}.${await signHmac(await signingKey, payload)}`
  }

  return {
    async replaceConfirmation(input, store) {
      assertConfirmationReplacementStrategy(input.replacementStrategy)
      const digest = await sha256Digest(input.token)
      return store.replace({
        record: {
          digest,
          purpose: CAPABILITY_PURPOSES.CONFIRMATION,
          contactId: input.contactId,
          subscriptionId: input.subscriptionId,
          lifecycleGeneration: input.lifecycleGeneration,
          createdAt: input.issuedAt,
          expiresAt: input.expiresAt,
          consumedAt: null,
          revokedAt: null
        },
        strategy: input.replacementStrategy,
        maxActiveTokens: input.maxActiveTokens,
        now: input.issuedAt
      })
    },

    async resolveConfirmation(token, now, store) {
      const record = await store.resolve({
        digest: await sha256Digest(token),
        now
      })
      if (record == null) return null
      return {
        contactId: record.contactId,
        subscriptionId: record.subscriptionId,
        lifecycleGeneration: record.lifecycleGeneration
      }
    },

    async consumeConfirmation(token, now, store) {
      const record = await store.consume({
        digest: await sha256Digest(token),
        now
      })
      if (record == null) return null
      return {
        contactId: record.contactId,
        subscriptionId: record.subscriptionId,
        lifecycleGeneration: record.lifecycleGeneration
      }
    },

    async revokeConfirmations(subscriptionId, lifecycleGeneration, now, store) {
      await store.revokeBySubscription({
        subscriptionId,
        lifecycleGeneration,
        now
      })
    },

    async issueUnsubscribeCapability(input) {
      return issueSignedCapability({ scope: 'SUBSCRIPTION', ...input })
    },

    async issueUnsubscribeAllCapability(input) {
      return issueSignedCapability({ scope: 'ALL', ...input })
    },

    async issueManagePreferencesCapability(input) {
      return issueSignedCapability({ scope: 'MANAGE', ...input })
    },

    async resolveUnsubscribeCapability(capability): Promise<UnsubscribeCapabilityTarget | null> {
      const parsed = parseCapability(capability)
      if (parsed == null) return null

      const key = parsed.keyVersion == null
        ? legacyKey
        : versionedKeys.get(parsed.keyVersion)
      if (key == null) return null
      const valid = await verifyHmac(
        await key,
        parsed.payload,
        parsed.signature
      )
      return valid ? parsed.target : null
    },

    async cleanupConfirmations(input, store) {
      return store.cleanup({
        deleteBefore: input.deleteBefore
      })
    }
  }
}

export function createHmacRateLimitKeyProvider(
  options: HmacRateLimitKeyProviderOptions
): RateLimitKeyProvider {
  const hmacKey = importHmacKey(options.secret, ['sign'])

  return {
    async createKey(input) {
      const material = options.material?.(input)
        ?? [input.action, input.email, input.audienceKey].join('\u0000')
      const signature = await crypto.subtle.sign(
        'HMAC',
        await hmacKey,
        textEncoder.encode(`rate-limit-v1\u0000${material}`)
      )
      return bytesToHex(new Uint8Array(signature))
    }
  }
}

/** Creates stable, non-reversible suppression keys from a normalized e-mail. */
export function createHmacSuppressionKeyProvider(options: {
  readonly secret: string | Uint8Array
}): (normalizedEmail: string) => Promise<string>
export function createHmacSuppressionKeyProvider(options: {
  readonly secrets: readonly VersionedSecret[]
}): (normalizedEmail: string) => Promise<readonly string[]>
export function createHmacSuppressionKeyProvider(options: {
  readonly secret?: string | Uint8Array
  readonly secrets?: readonly VersionedSecret[]
}): (normalizedEmail: string) => Promise<string | readonly string[]> {
  if (options.secrets === undefined) {
    if (options.secret == null) {
      throw new NewsletterError(NEWSLETTER_ERROR_CODES.INVALID_CONFIGURATION, 'A suppression HMAC secret is required.')
    }
    const key = importHmacKey(options.secret, ['sign'])
    return async email => bytesToHex(new Uint8Array(await crypto.subtle.sign(
      'HMAC', await key, textEncoder.encode(`suppression-v1\u0000${email}`)
    )))
  }
  if (options.secret !== undefined || !Array.isArray(options.secrets) || options.secrets.length === 0) {
    throw new NewsletterError(NEWSLETTER_ERROR_CODES.INVALID_CONFIGURATION, 'Configure a non-empty suppression secret ring.')
  }
  const versions = new Set<number>()
  const keys = options.secrets.map(entry => {
    if (entry == null || !Number.isSafeInteger(entry.version) || entry.version < 0 || versions.has(entry.version)) {
      throw new NewsletterError(NEWSLETTER_ERROR_CODES.INVALID_CONFIGURATION, 'Suppression secret versions must be unique non-negative safe integers.')
    }
    versions.add(entry.version)
    return importHmacKey(entry.value, ['sign'])
  })
  return async email => Promise.all(keys.map(async key => bytesToHex(new Uint8Array(await crypto.subtle.sign(
    'HMAC', await key, textEncoder.encode(`suppression-v1\u0000${email}`)
  )))))
}

export type {
  ConfirmationCapabilityTarget,
  ConfirmationReplacementResult,
  NewsletterCapabilities,
  UnsubscribeCapabilityTarget
} from './capabilities.js'
export type { NewsletterRateLimitCheck } from './config.js'
