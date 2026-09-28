export interface ConfirmationCapabilityTarget {
  readonly contactId: string
  readonly subscriptionId: string
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
 * Security mechanics intentionally live behind this contract. Issue #3 owns
 * cryptographic token generation, hashing, expiry persistence and hardened
 * replay/race guarantees.
 */
export interface NewsletterCapabilities {
  replaceConfirmation(input: {
    readonly token: string
    readonly contactId: string
    readonly subscriptionId: string
    readonly expiresAt: Date
  }): Promise<void>

  consumeConfirmation(
    token: string,
    now: Date
  ): Promise<ConfirmationCapabilityTarget | null>

  revokeConfirmations(subscriptionId: string): Promise<void>

  replaceUnsubscribeCapability(input: {
    readonly capability: string
    readonly contactId: string
    readonly subscriptionId: string
  }): Promise<void>

  replaceUnsubscribeAllCapability(input: {
    readonly capability: string
    readonly contactId: string
  }): Promise<void>

  resolveUnsubscribeCapability(
    capability: string
  ): Promise<UnsubscribeCapabilityTarget | null>

  revokeUnsubscribeCapabilities(subscriptionId: string): Promise<void>

  revokeUnsubscribeAllCapability(contactId: string): Promise<void>
}
