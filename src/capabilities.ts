import type { ConfirmationReplacementStrategy } from './security.js'

export interface ConfirmationCapabilityTarget {
  readonly contactId: string
  readonly subscriptionId: string
}

export interface ConfirmationReplacementResult {
  readonly replacedCount: number
  readonly expiredCount: number
}

export type UnsubscribeCapabilityTarget =
  | {
    readonly scope: 'SUBSCRIPTION'
    readonly contactId: string
    readonly subscriptionId: string
  }
  | {
    readonly scope: 'ALL'
    readonly contactId: string
  }

/**
 * Security-sensitive mechanics live behind this contract. Production adapters
 * must avoid persisting raw bearer tokens and must make confirmation
 * consumption atomic.
 */
export interface NewsletterCapabilities {
  replaceConfirmation(input: {
    readonly token: string
    readonly contactId: string
    readonly subscriptionId: string
    readonly issuedAt: Date
    readonly expiresAt: Date
    readonly replacementStrategy: ConfirmationReplacementStrategy
    readonly maxActiveTokens: number
  }): Promise<ConfirmationReplacementResult | void>

  consumeConfirmation(
    token: string,
    now: Date
  ): Promise<ConfirmationCapabilityTarget | null>

  revokeConfirmations(subscriptionId: string): Promise<void>

  /**
   * Preferred production path. Secure implementations can construct a signed,
   * purpose-bound capability without returning or storing a raw bearer secret.
   */
  issueUnsubscribeCapability?(input: {
    readonly contactId: string
    readonly subscriptionId: string
  }): Promise<string>

  issueUnsubscribeAllCapability?(input: {
    readonly contactId: string
  }): Promise<string>

  /**
   * Legacy/test adapter hooks retained for simple custom implementations.
   * Production implementations should prefer the issue* methods above.
   */
  replaceUnsubscribeCapability?(input: {
    readonly capability: string
    readonly contactId: string
    readonly subscriptionId: string
  }): Promise<void>

  replaceUnsubscribeAllCapability?(input: {
    readonly capability: string
    readonly contactId: string
  }): Promise<void>

  resolveUnsubscribeCapability(
    capability: string
  ): Promise<UnsubscribeCapabilityTarget | null>

  revokeUnsubscribeCapabilities(subscriptionId: string): Promise<void>

  revokeUnsubscribeAllCapability(contactId: string): Promise<void>

  cleanupConfirmations(input: {
    readonly deleteBefore: Date
  }): Promise<number>
}
