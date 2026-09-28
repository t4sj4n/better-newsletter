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
  readonly createdAt: Date
  readonly expiresAt: Date
  readonly consumedAt?: Date | null
  readonly revokedAt?: Date | null
}

export interface ConfirmationTokenStore {
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
    readonly now: Date
  }): Promise<number>

  cleanup(input: {
    readonly deleteBefore: Date
  }): Promise<number>
}

export interface CapabilityNonceRecord {
  readonly purpose: Exclude<CapabilityPurpose, 'CONFIRMATION'>
  readonly targetId: string
  readonly contactId: string
  readonly subscriptionId?: string
  readonly nonce: string
  readonly updatedAt: Date
}

export interface CapabilityNonceStore {
  get(
    purpose: CapabilityNonceRecord['purpose'],
    targetId: string
  ): Promise<CapabilityNonceRecord | null>

  set(record: CapabilityNonceRecord): Promise<void>

  delete(
    purpose: CapabilityNonceRecord['purpose'],
    targetId: string
  ): Promise<void>
}

export interface SecureCapabilitiesOptions {
  readonly confirmationStore: ConfirmationTokenStore
  readonly nonceStore: CapabilityNonceStore
  readonly hmacSecret: string | Uint8Array
  readonly nonceGenerator?: TokenGenerator
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

async function importHmacKey(
  secret: string | Uint8Array,
  usages: readonly KeyUsage[]
): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    toArrayBuffer(secretBytes(secret)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    [...usages]
  )
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

const capabilityCode = {
  UNSUBSCRIBE: 'u',
  UNSUBSCRIBE_ALL: 'a',
  MANAGE_PREFERENCES: 'm'
} as const

const capabilityPurposeByCode = {
  u: CAPABILITY_PURPOSES.UNSUBSCRIBE,
  a: CAPABILITY_PURPOSES.UNSUBSCRIBE_ALL,
  m: CAPABILITY_PURPOSES.MANAGE_PREFERENCES
} as const

function capabilityPayload(
  purpose: CapabilityNonceRecord['purpose'],
  targetId: string,
  nonce: string
): string {
  return [
    'bn1',
    capabilityCode[purpose],
    stringToBase64Url(targetId),
    stringToBase64Url(nonce)
  ].join('.')
}

function parseCapability(capability: string): {
  purpose: CapabilityNonceRecord['purpose']
  targetId: string
  nonce: string
  payload: string
  signature: string
} | null {
  const parts = capability.split('.')
  if (parts.length !== 5 || parts[0] !== 'bn1') return null

  const code = parts[1] as keyof typeof capabilityPurposeByCode
  const purpose = capabilityPurposeByCode[code]
  if (purpose == null) return null

  const targetId = base64UrlToString(parts[2]!)
  const nonce = base64UrlToString(parts[3]!)
  if (targetId == null || nonce == null || targetId.length === 0 || nonce.length === 0) {
    return null
  }

  return {
    purpose,
    targetId,
    nonce,
    payload: parts.slice(0, 4).join('.'),
    signature: parts[4]!
  }
}

export function createSecureCapabilities(
  options: SecureCapabilitiesOptions
): NewsletterCapabilities {
  const nonceGenerator = options.nonceGenerator ?? secureTokenGenerator
  const hmacKey = importHmacKey(options.hmacSecret, ['sign', 'verify'])

  const getOrCreateNonce = async (
    purpose: CapabilityNonceRecord['purpose'],
    targetId: string,
    target: { contactId: string; subscriptionId?: string }
  ): Promise<CapabilityNonceRecord> => {
    const existing = await options.nonceStore.get(purpose, targetId)
    if (existing != null) return existing

    const now = new Date()
    const record: CapabilityNonceRecord = {
      purpose,
      targetId,
      contactId: target.contactId,
      ...(target.subscriptionId !== undefined
        ? { subscriptionId: target.subscriptionId }
        : {}),
      nonce: await nonceGenerator.generate(),
      updatedAt: now
    }
    await options.nonceStore.set(record)
    return record
  }

  const issueSignedCapability = async (
    purpose: CapabilityNonceRecord['purpose'],
    targetId: string,
    target: { contactId: string; subscriptionId?: string }
  ): Promise<string> => {
    const record = await getOrCreateNonce(purpose, targetId, target)
    const payload = capabilityPayload(purpose, targetId, record.nonce)
    return `${payload}.${await signHmac(await hmacKey, payload)}`
  }

  const rotateNonce = async (
    purpose: CapabilityNonceRecord['purpose'],
    targetId: string
  ): Promise<void> => {
    const existing = await options.nonceStore.get(purpose, targetId)
    if (existing == null) return
    await options.nonceStore.set({
      ...existing,
      nonce: await nonceGenerator.generate(),
      updatedAt: new Date()
    })
  }

  return {
    async replaceConfirmation(input) {
      const digest = await sha256Digest(input.token)
      return options.confirmationStore.replace({
        record: {
          digest,
          purpose: CAPABILITY_PURPOSES.CONFIRMATION,
          contactId: input.contactId,
          subscriptionId: input.subscriptionId,
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

    async resolveConfirmation(token, now) {
      const record = await options.confirmationStore.resolve({
        digest: await sha256Digest(token),
        now
      })
      if (record == null) return null
      return {
        contactId: record.contactId,
        subscriptionId: record.subscriptionId
      }
    },

    async consumeConfirmation(token, now) {
      const record = await options.confirmationStore.consume({
        digest: await sha256Digest(token),
        now
      })
      if (record == null) return null
      return {
        contactId: record.contactId,
        subscriptionId: record.subscriptionId
      }
    },

    async revokeConfirmations(subscriptionId) {
      await options.confirmationStore.revokeBySubscription({
        subscriptionId,
        now: new Date()
      })
    },

    async issueUnsubscribeCapability(input) {
      return issueSignedCapability(
        CAPABILITY_PURPOSES.UNSUBSCRIBE,
        input.subscriptionId,
        input
      )
    },

    async issueUnsubscribeAllCapability(input) {
      return issueSignedCapability(
        CAPABILITY_PURPOSES.UNSUBSCRIBE_ALL,
        input.contactId,
        input
      )
    },

    async resolveUnsubscribeCapability(capability): Promise<UnsubscribeCapabilityTarget | null> {
      const parsed = parseCapability(capability)
      if (
        parsed == null
        || (
          parsed.purpose !== CAPABILITY_PURPOSES.UNSUBSCRIBE
          && parsed.purpose !== CAPABILITY_PURPOSES.UNSUBSCRIBE_ALL
        )
      ) {
        return null
      }

      const record = await options.nonceStore.get(parsed.purpose, parsed.targetId)
      if (record == null || record.nonce !== parsed.nonce) return null

      const valid = await verifyHmac(
        await hmacKey,
        parsed.payload,
        parsed.signature
      )
      if (!valid) return null

      if (parsed.purpose === CAPABILITY_PURPOSES.UNSUBSCRIBE) {
        if (record.subscriptionId == null) return null
        return {
          scope: 'SUBSCRIPTION',
          contactId: record.contactId,
          subscriptionId: record.subscriptionId
        }
      }

      return {
        scope: 'ALL',
        contactId: record.contactId
      }
    },

    async revokeUnsubscribeCapabilities(subscriptionId) {
      await rotateNonce(CAPABILITY_PURPOSES.UNSUBSCRIBE, subscriptionId)
      await rotateNonce(CAPABILITY_PURPOSES.MANAGE_PREFERENCES, subscriptionId)
    },

    async revokeUnsubscribeAllCapability(contactId) {
      await rotateNonce(CAPABILITY_PURPOSES.UNSUBSCRIBE_ALL, contactId)
    },

    async cleanupConfirmations(input) {
      return options.confirmationStore.cleanup({
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
