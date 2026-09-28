import type {
  NewsletterCapabilities,
  UnsubscribeCapabilityTarget
} from './capabilities.js'
import type {
  Contact,
  NewsletterEvent,
  Subscription
} from './domain.js'
import type {
  ContactPatch,
  CreateContactInput,
  CreateSubscriptionInput,
  NewsletterStorage,
  NewsletterStorageTransaction,
  SubscriptionPatch
} from './storage.js'

interface MemoryState {
  contacts: Map<string, Contact>
  contactByEmail: Map<string, string>
  subscriptions: Map<string, Subscription>
  subscriptionByContactAudience: Map<string, string>
  events: NewsletterEvent[]
}

/** Deep-copies supported values so callers cannot mutate stored state by reference. */
function clone<T>(value: T): T {
  return structuredClone(value)
}

/** Joins a contact ID and audience key with a null separator for the memory index. */
function subscriptionKey(contactId: string, audienceKey: string): string {
  return `${contactId}\u0000${audienceKey}`
}

export class MemoryNewsletterStorage implements NewsletterStorage {
  private state: MemoryState = {
    contacts: new Map(),
    contactByEmail: new Map(),
    subscriptions: new Map(),
    subscriptionByContactAudience: new Map(),
    events: []
  }

  private queue: Promise<void> = Promise.resolve()

  transaction<T>(
    operation: (transaction: NewsletterStorageTransaction) => Promise<T>
  ): Promise<T> {
    const run = this.queue.then(async () => {
      const snapshot = clone(this.state)
      try {
        return await operation(this.createTransaction())
      } catch (error) {
        this.state = snapshot
        throw error
      }
    })

    this.queue = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  private createTransaction(): NewsletterStorageTransaction {
    return {
      getContactByEmail: async email => {
        const id = this.state.contactByEmail.get(email)
        return id == null ? null : clone(this.state.contacts.get(id) ?? null)
      },
      getContactById: async id => clone(this.state.contacts.get(id) ?? null),
      createContact: async input => this.createContact(input),
      updateContact: async (id, patch) => this.updateContact(id, patch),
      getSubscription: async (contactId, audienceKey) => {
        const id = this.state.subscriptionByContactAudience.get(
          subscriptionKey(contactId, audienceKey)
        )
        return id == null
          ? null
          : clone(this.state.subscriptions.get(id) ?? null)
      },
      getSubscriptionById: async id =>
        clone(this.state.subscriptions.get(id) ?? null),
      createSubscription: async input => this.createSubscription(input),
      updateSubscription: async (id, patch) =>
        this.updateSubscription(id, patch),
      listSubscriptions: async contactId =>
        [...this.state.subscriptions.values()]
          .filter(subscription => subscription.contactId === contactId)
          .map(clone),
      appendEvent: async event => {
        this.state.events.push(clone(event))
      },
      listEvents: async contactId =>
        this.state.events
          .filter(event => event.contactId === contactId)
          .map(clone)
    }
  }

  private createContact(input: CreateContactInput): Contact {
    if (this.state.contacts.has(input.id)) {
      throw new Error(`Contact id already exists: ${input.id}`)
    }
    if (this.state.contactByEmail.has(input.email)) {
      throw new Error(`Contact e-mail already exists: ${input.email}`)
    }

    const contact: Contact = clone(input)
    this.state.contacts.set(contact.id, contact)
    this.state.contactByEmail.set(contact.email, contact.id)
    return clone(contact)
  }

  private updateContact(id: string, patch: ContactPatch): Contact {
    const existing = this.state.contacts.get(id)
    if (existing == null) throw new Error(`Unknown contact: ${id}`)

    const updated: Contact = clone({ ...existing, ...patch })
    this.state.contacts.set(id, updated)
    return clone(updated)
  }

  private createSubscription(input: CreateSubscriptionInput): Subscription {
    if (this.state.subscriptions.has(input.id)) {
      throw new Error(`Subscription id already exists: ${input.id}`)
    }

    const key = subscriptionKey(input.contactId, input.audienceKey)
    if (this.state.subscriptionByContactAudience.has(key)) {
      throw new Error(`Subscription already exists: ${key}`)
    }

    const subscription: Subscription = clone(input)
    this.state.subscriptions.set(subscription.id, subscription)
    this.state.subscriptionByContactAudience.set(key, subscription.id)
    return clone(subscription)
  }

  private updateSubscription(
    id: string,
    patch: SubscriptionPatch
  ): Subscription {
    const existing = this.state.subscriptions.get(id)
    if (existing == null) throw new Error(`Unknown subscription: ${id}`)

    const updated: Subscription = clone({ ...existing, ...patch })
    this.state.subscriptions.set(id, updated)
    return clone(updated)
  }
}

/** Creates an isolated in-memory store with serialized transactions and rollback. */
export function memoryStorage(): MemoryNewsletterStorage {
  return new MemoryNewsletterStorage()
}

interface StoredConfirmation {
  readonly contactId: string
  readonly subscriptionId: string
  readonly expiresAt: Date
}

/** Test/development capability adapter. It stores raw opaque values in memory and is not production security. */
export class MemoryNewsletterCapabilities implements NewsletterCapabilities {
  private readonly confirmations = new Map<string, StoredConfirmation>()
  private readonly confirmationBySubscription = new Map<string, string>()
  private readonly unsubscribe = new Map<string, UnsubscribeCapabilityTarget>()
  private readonly unsubscribeBySubscription = new Map<string, string>()
  private readonly unsubscribeAllByContact = new Map<string, string>()

  async replaceConfirmation(input: {
    readonly token: string
    readonly contactId: string
    readonly subscriptionId: string
    readonly expiresAt: Date
  }): Promise<void> {
    await this.revokeConfirmations(input.subscriptionId)
    this.confirmations.set(input.token, {
      contactId: input.contactId,
      subscriptionId: input.subscriptionId,
      expiresAt: clone(input.expiresAt)
    })
    this.confirmationBySubscription.set(input.subscriptionId, input.token)
  }

  async consumeConfirmation(token: string, now: Date) {
    const stored = this.confirmations.get(token)
    if (stored == null) return null

    this.confirmations.delete(token)
    if (this.confirmationBySubscription.get(stored.subscriptionId) === token) {
      this.confirmationBySubscription.delete(stored.subscriptionId)
    }

    if (stored.expiresAt.getTime() <= now.getTime()) return null
    return {
      contactId: stored.contactId,
      subscriptionId: stored.subscriptionId
    }
  }

  async revokeConfirmations(subscriptionId: string): Promise<void> {
    const token = this.confirmationBySubscription.get(subscriptionId)
    if (token != null) this.confirmations.delete(token)
    this.confirmationBySubscription.delete(subscriptionId)
  }

  async replaceUnsubscribeCapability(input: {
    readonly capability: string
    readonly contactId: string
    readonly subscriptionId: string
  }): Promise<void> {
    await this.revokeUnsubscribeCapabilities(input.subscriptionId)
    this.unsubscribe.set(input.capability, {
      scope: 'SUBSCRIPTION',
      contactId: input.contactId,
      subscriptionId: input.subscriptionId
    })
    this.unsubscribeBySubscription.set(
      input.subscriptionId,
      input.capability
    )
  }

  async replaceUnsubscribeAllCapability(input: {
    readonly capability: string
    readonly contactId: string
  }): Promise<void> {
    const previous = this.unsubscribeAllByContact.get(input.contactId)
    if (previous != null) this.unsubscribe.delete(previous)
    this.unsubscribe.set(input.capability, {
      scope: 'ALL',
      contactId: input.contactId
    })
    this.unsubscribeAllByContact.set(input.contactId, input.capability)
  }

  async resolveUnsubscribeCapability(capability: string) {
    return clone(this.unsubscribe.get(capability) ?? null)
  }

  async revokeUnsubscribeCapabilities(subscriptionId: string): Promise<void> {
    const capability = this.unsubscribeBySubscription.get(subscriptionId)
    if (capability != null) this.unsubscribe.delete(capability)
    this.unsubscribeBySubscription.delete(subscriptionId)
  }

  async revokeUnsubscribeAllCapability(contactId: string): Promise<void> {
    const capability = this.unsubscribeAllByContact.get(contactId)
    if (capability != null) this.unsubscribe.delete(capability)
    this.unsubscribeAllByContact.delete(contactId)
  }

  async cleanupConfirmations(): Promise<number> {
    return 0
  }
}

/**
 * Creates an isolated capability adapter for tests and development.
 * Stores raw opaque values in memory and provides no production token security.
 */
export function memoryCapabilities(): MemoryNewsletterCapabilities {
  return new MemoryNewsletterCapabilities()
}


export {
  MemoryCapabilityNonceStore,
  MemoryConfirmationTokenStore,
  MemoryRateLimiter,
  memoryCapabilityNonceStore,
  memoryConfirmationTokenStore,
  memoryRateLimiter
} from './memory-security.js'
