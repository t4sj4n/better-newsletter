import type {
  ConfirmationReplacementStrategy,
  ConfirmationTokenStore
} from './security.js'

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
  | {
    readonly scope: 'MANAGE'
    readonly contactId: string
    readonly capabilityGeneration: number
  }

/**
 * Security-sensitive mechanics live behind this contract. Production adapters
 * must avoid persisting raw bearer tokens and must make confirmation
 * consumption atomic. Resolved targets are not authorization by themselves:
 * the core must match their generation against persisted state transactionally.
 *
 * Confirmation methods receive the token store of the current lifecycle
 * transaction and must not write anywhere else, so they stay retry-safe.
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
  }, store: ConfirmationTokenStore): Promise<ConfirmationReplacementResult | void>

  resolveConfirmation(
    token: string,
    now: Date,
    store: ConfirmationTokenStore
  ): Promise<ConfirmationCapabilityTarget | null>

  consumeConfirmation(
    token: string,
    now: Date,
    store: ConfirmationTokenStore
  ): Promise<ConfirmationCapabilityTarget | null>

  revokeConfirmations(
    subscriptionId: string,
    lifecycleGeneration: number,
    now: Date,
    store: ConfirmationTokenStore
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
  issueManagePreferencesCapability(input: {
    readonly contactId: string
    readonly capabilityGeneration: number
  }): Promise<string>

  resolveUnsubscribeCapability(
    capability: string
  ): Promise<UnsubscribeCapabilityTarget | null>

  cleanupConfirmations(input: {
    readonly deleteBefore: Date
  }, store: ConfirmationTokenStore): Promise<number>
}
