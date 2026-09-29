import type { NewsletterCapabilities } from './capabilities.js'
import { createSecureCapabilities, type ConfirmationTokenRecord } from './security.js'
import { MemoryConfirmationTokenStore } from './memory-security.js'
import type {
  Contact,
  NewsletterEvent,
  Subscription
} from './domain.js'
import { StorageConflictError } from './errors.js'
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
  providerEvents: Set<string>
  confirmationTokens: Map<string, ConfirmationTokenRecord>
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
    events: [],
    providerEvents: new Set(),
    confirmationTokens: new Map()
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
      claimProviderEvent: async (provider, eventId) => {
        const key = JSON.stringify([provider, eventId])
        if (this.state.providerEvents.has(key)) return false
        this.state.providerEvents.add(key)
        return true
      },
      listEvents: async contactId =>
        this.state.events
          .filter(event => event.contactId === contactId)
          .map(clone),
      confirmationTokens: new MemoryConfirmationTokenStore(
        this.state.confirmationTokens
      )
    }
  }

  /** Returns committed confirmation-token records, e.g. to assert digests in tests. */
  confirmationTokenSnapshot(): readonly ConfirmationTokenRecord[] {
    return [...this.state.confirmationTokens.values()].map(clone)
  }

  private createContact(input: CreateContactInput): Contact {
    if (this.state.contacts.has(input.id)) {
      throw new StorageConflictError(`Contact id already exists: ${input.id}`)
    }
    if (this.state.contactByEmail.has(input.email)) {
      throw new StorageConflictError('Contact e-mail already exists.')
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
      throw new StorageConflictError(`Subscription id already exists: ${input.id}`)
    }

    const key = subscriptionKey(input.contactId, input.audienceKey)
    if (this.state.subscriptionByContactAudience.has(key)) {
      throw new StorageConflictError('Subscription already exists for this contact and audience.')
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
export function memoryAdapter(): MemoryNewsletterStorage {
  return new MemoryNewsletterStorage()
}

/**
 * Creates secure capabilities with an ephemeral signing key. Confirmation
 * digests live in the storage transaction's token store. The key does not
 * survive a restart.
 */
export function memoryCapabilities(): NewsletterCapabilities {
  return createSecureCapabilities({
    hmacSecret: crypto.getRandomValues(new Uint8Array(32))
  })
}


export {
  MemoryConfirmationTokenStore,
  MemoryRateLimiter,
  memoryConfirmationTokenStore,
  memoryRateLimiter
} from './memory-security.js'
