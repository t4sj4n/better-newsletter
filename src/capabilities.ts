import type { ConfirmationReplacementStrategy } from './security.js'

export interface ConfirmationCapabilityTarget {
  readonly contactId: string
  readonly subscriptionId: string
  readonly lifecycleGeneration: number
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
    readonly lifecycleGeneration: number
  }
  | {
    readonly scope: 'ALL'
    readonly contactId: string
    readonly capabilityGeneration: number
  }

/**
 * Security-sensitive mechanics live behind this contract. Production adapters
 * must avoid persisting raw bearer tokens and must make confirmation
 * consumption atomic. Resolved targets are not authorization by themselves:
 * the core must match their generation against persisted state transactionally.
 */
export interface NewsletterCapabilities {
  replaceConfirmation(input: {
    readonly token: string
    readonly contactId: string
    readonly subscriptionId: string
    readonly lifecycleGeneration: number
    readonly issuedAt: Date
    readonly expiresAt: Date
    readonly replacementStrategy: ConfirmationReplacementStrategy
    readonly maxActiveTokens: number
  }): Promise<ConfirmationReplacementResult | void>

  resolveConfirmation(
    token: string,
    now: Date
  ): Promise<ConfirmationCapabilityTarget | null>

  consumeConfirmation(
    token: string,
    now: Date
  ): Promise<ConfirmationCapabilityTarget | null>

  revokeConfirmations(
    subscriptionId: string,
    lifecycleGeneration: number
  ): Promise<void>

  /**
   * Sign the purpose, target IDs and generation without mutable nonce state.
   */
  issueUnsubscribeCapability(input: {
    readonly contactId: string
    readonly subscriptionId: string
    readonly lifecycleGeneration: number
  }): Promise<string>

  issueUnsubscribeAllCapability(input: {
    readonly contactId: string
    readonly capabilityGeneration: number
  }): Promise<string>

  resolveUnsubscribeCapability(
    capability: string
  ): Promise<UnsubscribeCapabilityTarget | null>

  cleanupConfirmations(input: {
    readonly deleteBefore: Date
  }): Promise<number>
}
