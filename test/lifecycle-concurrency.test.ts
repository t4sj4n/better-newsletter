import { describe, expect, it, vi } from 'vitest'
import {
  CONFIRMATION_REPLACEMENT_STRATEGIES,
  MAIL_DELIVERY_FAILURES,
  MAIL_DELIVERY_REASONS,
  NEWSLETTER_EVENT_TYPES,
  StorageConflictError,
  SUBSCRIPTION_STATUSES,
  betterNewsletter,
  type ConfirmationMailInput,
  type ConfirmationOptions,
  type NewsletterStorage
} from '../packages/better-newsletter/src/index.js'
import { createSecureCapabilities } from '../packages/better-newsletter/src/security.js'
import { memoryAdapter } from '../packages/better-newsletter/src/adapters/memory.js'

const email = 'person@example.com'
const signup = { email, consent: { granted: true, version: 'v1' } }
const secret = '0123456789abcdef0123456789abcdef'

function gate() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}

/** Holds the first transaction until `resume` is released. */
function delayedStorage(
  storage: NewsletterStorage,
  reached: ReturnType<typeof gate>,
  resume: ReturnType<typeof gate>
): NewsletterStorage {
  let first = true
  return {
    async transaction(operation) {
      if (first) {
        first = false
        reached.release()
        await resume.promise
      }
      return storage.transaction(operation)
    }
  }
}

function setup(confirmation: ConfirmationOptions = {}) {
  let nowMs = Date.parse('2026-09-28T10:00:00.000Z')
  let token = 0
  const storage = memoryAdapter()
  const background = new WeakMap<object, Promise<void>[]>()
  const messages: ConfirmationMailInput[] = []
  const mailer = {
    sendConfirmation: vi.fn(async (input: ConfirmationMailInput) => {
      messages.push(input)
      return { accepted: true }
    })
  }
  const createInstance = (instanceStorage: NewsletterStorage = storage) => {
    const tasks: Promise<void>[] = []
    const instance = betterNewsletter({
      storage: instanceStorage,
      capabilities: createSecureCapabilities({ hmacSecret: secret }),
      mailer,
      tokenGenerator: { generate: (): string | Promise<string> => `token-${++token}` },
      clock: { now: () => new Date(nowMs) },
      confirmation: { deliveryLeaseMs: 1_000, ...confirmation },
      runBackground: task => { tasks.push(task) }
    })
    background.set(instance, tasks)
    return instance
  }
  const newsletter = createInstance()
  /** Awaits background delivery started by one service instance. */
  const settle = async (instance: object = newsletter) => {
    const tasks = background.get(instance)!
    while (tasks.length > 0) await Promise.all(tasks.splice(0))
  }
  const waitForEvents = async (type: string, count: number) => {
    await vi.waitFor(async () => {
      const events = await newsletter.listEvents({ email })
      expect(events.filter(event => event.type === type)).toHaveLength(count)
    })
  }
  return {
    newsletter, createInstance, storage, mailer, messages, waitForEvents, settle,
    tokens: () => storage.confirmationTokenSnapshot(),
    advance: (ms: number) => { nowMs += ms }
  }
}

describe('generation-bound lifecycle concurrency', () => {
  it.each(['confirm', 'unsubscribe', 'unsubscribeAll'] as const)(
    'rejects an old resolved %s target after another instance starts a new cycle',
    async action => {
      const { newsletter, createInstance, storage, messages, waitForEvents } = setup()
      await newsletter.subscribe(signup)
      await waitForEvents(NEWSLETTER_EVENT_TYPES.CONFIRMATION_SENT, 1)
      const single = (await newsletter.createUnsubscribeCapability({ email }))!
      const all = (await newsletter.createUnsubscribeCapability({ email, all: true }))!
      const resolved = gate()
      const resume = gate()
      // Confirmation resolves inside its transaction, so delay the whole
      // request; signed unsubscribe targets resolve before any transaction.
      const reader = createInstance(action === 'confirm'
        ? delayedStorage(storage, resolved, resume)
        : storage)

      if (action !== 'confirm') {
        const original = reader.capabilities.resolveUnsubscribeCapability
        vi.spyOn(reader.capabilities, 'resolveUnsubscribeCapability').mockImplementationOnce(async value => {
          const target = await original(value)
          expect(target).not.toBeNull()
          resolved.release()
          await resume.promise
          return target
        })
      }
      const stale = action === 'confirm'
        ? reader.confirm({ token: messages[0]!.token })
        : reader[action]({ capability: action === 'unsubscribe' ? single : all })

      try {
        await resolved.promise
        await newsletter.unsubscribe({ capability: single })
        // Identical consent and time must still create a distinct generation.
        await newsletter.subscribe(signup)
        await waitForEvents(NEWSLETTER_EVENT_TYPES.CONFIRMATION_SENT, 2)
        expect(await newsletter.getSubscription({ email })).toMatchObject({
          lifecycleGeneration: 2,
          status: SUBSCRIPTION_STATUSES.PENDING_CONFIRMATION
        })
        expect(await newsletter.getContact({ email })).toMatchObject({ capabilityGeneration: 2 })
      } finally {
        resume.release()
      }
      expect(await stale).toEqual(action === 'confirm'
        ? { confirmed: false }
        : { unsubscribed: false })
      expect((await newsletter.getSubscription({ email }))?.status)
        .toBe(SUBSCRIPTION_STATUSES.PENDING_CONFIRMATION)
      await expect(newsletter.confirm({ token: messages[1]!.token }))
        .resolves.toEqual({ confirmed: true })
    }
  )

  it('invalidates an in-flight unsubscribe-all target when an existing contact starts a new audience', async () => {
    const { newsletter, createInstance, waitForEvents } = setup()
    await newsletter.subscribe(signup)
    await waitForEvents(NEWSLETTER_EVENT_TYPES.CONFIRMATION_SENT, 1)

    const all = (await newsletter.createUnsubscribeCapability({
      email,
      all: true
    }))!
    const reader = createInstance()
    const resolved = gate()
    const resume = gate()
    const original = reader.capabilities.resolveUnsubscribeCapability

    vi.spyOn(reader.capabilities, 'resolveUnsubscribeCapability')
      .mockImplementationOnce(async value => {
        const target = await original(value)
        expect(target).toMatchObject({
          scope: 'ALL',
          capabilityGeneration: 1
        })
        resolved.release()
        await resume.promise
        return target
      })

    const stale = reader.unsubscribeAll({ capability: all })

    try {
      await resolved.promise
      await newsletter.subscribe({
        ...signup,
        audience: 'product-news'
      })
      await waitForEvents(NEWSLETTER_EVENT_TYPES.CONFIRMATION_SENT, 2)

      expect(await newsletter.getContact({ email })).toMatchObject({
        capabilityGeneration: 2
      })
      expect(await newsletter.getSubscription({
        email,
        audience: 'product-news'
      })).toMatchObject({
        lifecycleGeneration: 1,
        status: SUBSCRIPTION_STATUSES.PENDING_CONFIRMATION
      })
    } finally {
      resume.release()
    }

    await expect(stale).resolves.toEqual({ unsubscribed: false })
    expect((await newsletter.getSubscription({ email }))?.status)
      .toBe(SUBSCRIPTION_STATUSES.PENDING_CONFIRMATION)
    expect((await newsletter.getSubscription({
      email,
      audience: 'product-news'
    }))?.status).toBe(SUBSCRIPTION_STATUSES.PENDING_CONFIRMATION)
  })

  it('issues valid identical links concurrently across independent signers', async () => {
    const { newsletter, createInstance, waitForEvents } = setup()
    await newsletter.subscribe(signup)
    await waitForEvents(NEWSLETTER_EVENT_TYPES.CONFIRMATION_SENT, 1)
    const other = createInstance()

    for (const all of [false, true]) {
      const links = await Promise.all(Array.from({ length: 12 }, (_, index) =>
        (index % 2 === 0 ? newsletter : other).createUnsubscribeCapability({ email, all })
      ))
      expect(new Set(links).size).toBe(1)
      for (const link of links) {
        await expect(other.capabilities.resolveUnsubscribeCapability(link!))
          .resolves.toMatchObject(all
            ? { scope: 'ALL', capabilityGeneration: 1 }
            : { scope: 'SUBSCRIPTION', lifecycleGeneration: 1 })
      }
    }
  })

  it.each(['expiry', 'replacement'] as const)(
    'rechecks token validity inside the transition after delayed resolution and %s',
    async invalidation => {
      const { newsletter, createInstance, storage, messages, advance, waitForEvents, settle } = setup({
        expiresInMs: 1_000,
        replacementStrategy: CONFIRMATION_REPLACEMENT_STRATEGIES.REPLACE_PREVIOUS
      })
      await newsletter.subscribe(signup)
      await waitForEvents(NEWSLETTER_EVENT_TYPES.CONFIRMATION_SENT, 1)
      const resolved = gate()
      const resume = gate()
      const reader = createInstance(delayedStorage(storage, resolved, resume))
      const confirming = reader.confirm({ token: messages[0]!.token })
      try {
        await resolved.promise
        if (invalidation === 'expiry') {
          advance(1_000)
        } else {
          await newsletter.resendConfirmation({ email })
          await settle()
          expect(messages).toHaveLength(2)
        }
      } finally {
        resume.release()
      }
      await expect(confirming).resolves.toEqual({ confirmed: false })
      expect((await newsletter.getSubscription({ email }))?.status)
        .toBe(SUBSCRIPTION_STATUSES.PENDING_CONFIRMATION)
    }
  )

  it('allows only one concurrent confirmation transition across service instances', async () => {
    const { newsletter, createInstance, messages, waitForEvents } = setup()
    await newsletter.subscribe(signup)
    await waitForEvents(NEWSLETTER_EVENT_TYPES.CONFIRMATION_SENT, 1)
    const results = await Promise.all([
      newsletter.confirm({ token: messages[0]!.token }),
      createInstance().confirm({ token: messages[0]!.token })
    ])
    expect(results.filter(result => result.confirmed)).toHaveLength(1)
    await waitForEvents(NEWSLETTER_EVENT_TYPES.CONFIRMED, 1)
  })

  it('does not let delayed old token setup replace or mark new-generation delivery', async () => {
    const { newsletter, createInstance, tokens, messages, waitForEvents, settle } = setup()
    await newsletter.subscribe(signup)
    await waitForEvents(NEWSLETTER_EVENT_TYPES.CONFIRMATION_SENT, 1)
    const started = gate()
    const resume = gate()
    const generate = newsletter.tokenGenerator.generate
    vi.spyOn(newsletter.tokenGenerator, 'generate').mockImplementationOnce(async () => {
      started.release()
      await resume.promise
      return generate()
    })
    const resend = newsletter.resendConfirmation({ email })
    await started.promise
    const oldCapability = (await newsletter.createUnsubscribeCapability({ email }))!
    const other = createInstance()
    try {
      await other.unsubscribe({ capability: oldCapability })
      await other.subscribe(signup)
      await waitForEvents(NEWSLETTER_EVENT_TYPES.CONFIRMATION_SENT, 2)
    } finally {
      resume.release()
    }
    await resend
    await settle()
    expect(tokens()).toHaveLength(2)
    expect(messages).toHaveLength(2)
    expect(messages[1]!.subscription.lifecycleGeneration).toBe(2)
    expect(messages[1]!.lifecycleGeneration).toBe(2)
    await expect(other.confirm({ token: messages[1]!.token }))
      .resolves.toEqual({ confirmed: true })
  })

  it('fences stale same-generation setup before it can replace a newer delivered token', async () => {
    const { newsletter, createInstance, messages, advance, waitForEvents, settle } = setup({
      replacementStrategy: CONFIRMATION_REPLACEMENT_STRATEGIES.REPLACE_PREVIOUS
    })
    await newsletter.subscribe(signup)
    await waitForEvents(NEWSLETTER_EVENT_TYPES.CONFIRMATION_SENT, 1)
    const started = gate()
    const resume = gate()
    const generate = newsletter.tokenGenerator.generate
    vi.spyOn(newsletter.tokenGenerator, 'generate').mockImplementationOnce(async () => {
      started.release()
      await resume.promise
      return generate()
    })
    const oldResend = newsletter.resendConfirmation({ email })
    const other = createInstance()
    try {
      await started.promise
      advance(1_001)
      await other.resendConfirmation({ email })
      await settle(other)
      expect(messages).toHaveLength(2)
    } finally {
      resume.release()
    }
    await oldResend
    await settle()
    expect(messages).toHaveLength(2)
    await expect(other.confirm({ token: messages[1]!.token }))
      .resolves.toEqual({ confirmed: true })
  })

  it('rolls back both generations and queued work if re-subscription fails', async () => {
    const { newsletter, createInstance, storage, waitForEvents } = setup()
    await newsletter.subscribe(signup)
    await waitForEvents(NEWSLETTER_EVENT_TYPES.CONFIRMATION_SENT, 1)
    const capability = (await newsletter.createUnsubscribeCapability({ email }))!
    await newsletter.unsubscribe({ capability })
    const failing = createInstance({
      transaction: operation => storage.transaction(transaction => operation({
        ...transaction,
        async appendEvent(event) {
          if (event.type === NEWSLETTER_EVENT_TYPES.RESUBSCRIBED) throw new Error('rollback')
          await transaction.appendEvent(event)
        }
      }))
    })
    await expect(failing.subscribe(signup)).rejects.toThrow('rollback')
    expect(await newsletter.getSubscription({ email })).toMatchObject({
      lifecycleGeneration: 1,
      status: SUBSCRIPTION_STATUSES.UNSUBSCRIBED,
      confirmationDelivery: null
    })
    expect((await newsletter.getContact({ email }))?.capabilityGeneration).toBe(1)
    await newsletter.subscribe(signup)
    await waitForEvents(NEWSLETTER_EVENT_TYPES.CONFIRMATION_SENT, 2)
    expect((await newsletter.getSubscription({ email }))?.lifecycleGeneration).toBe(2)
  })
})

describe('transactional capability state', () => {
  it('rolls back confirmation when token consumption fails', async () => {
    const { newsletter, messages, waitForEvents } = setup()
    await newsletter.subscribe(signup)
    await waitForEvents(NEWSLETTER_EVENT_TYPES.CONFIRMATION_SENT, 1)

    vi.spyOn(newsletter.capabilities, 'consumeConfirmation')
      .mockRejectedValueOnce(new Error('token store unavailable'))

    await expect(newsletter.confirm({ token: messages[0]!.token }))
      .rejects.toThrow('token store unavailable')
    expect((await newsletter.getSubscription({ email }))?.status)
      .toBe(SUBSCRIPTION_STATUSES.PENDING_CONFIRMATION)
    await expect(newsletter.confirm({ token: messages[0]!.token }))
      .resolves.toEqual({ confirmed: true })
  })

  it('rolls back unsubscribe when token revocation fails', async () => {
    const { newsletter, waitForEvents, tokens } = setup()
    await newsletter.subscribe(signup)
    await waitForEvents(NEWSLETTER_EVENT_TYPES.CONFIRMATION_SENT, 1)
    const capability = (await newsletter.createUnsubscribeCapability({ email }))!

    vi.spyOn(newsletter.capabilities, 'revokeConfirmations')
      .mockRejectedValueOnce(new Error('token store unavailable'))

    await expect(newsletter.unsubscribe({ capability }))
      .rejects.toThrow('token store unavailable')
    expect((await newsletter.getSubscription({ email }))?.status)
      .toBe(SUBSCRIPTION_STATUSES.PENDING_CONFIRMATION)
    expect(tokens().filter(record => record.revokedAt == null)).toHaveLength(1)

    await expect(newsletter.unsubscribe({ capability }))
      .resolves.toEqual({ unsubscribed: true })
    expect(tokens().filter(record => record.revokedAt == null)).toHaveLength(0)
  })

  it('does not keep replaced tokens revoked when token setup rolls back', async () => {
    const { newsletter, createInstance, storage, messages, tokens, advance, waitForEvents } = setup({
      replacementStrategy: CONFIRMATION_REPLACEMENT_STRATEGIES.REPLACE_PREVIOUS
    })
    await newsletter.subscribe(signup)
    await waitForEvents(NEWSLETTER_EVENT_TYPES.CONFIRMATION_SENT, 1)
    const failing = createInstance({
      transaction: operation => storage.transaction(transaction => operation({
        ...transaction,
        async appendEvent(event) {
          if (event.type === NEWSLETTER_EVENT_TYPES.CONFIRMATION_REPLACED) {
            throw new Error('rollback')
          }
          await transaction.appendEvent(event)
        }
      }))
    })

    advance(1)
    await failing.resendConfirmation({ email })
    await waitForEvents(NEWSLETTER_EVENT_TYPES.CONFIRMATION_SEND_FAILED, 1)
    expect(messages).toHaveLength(1)
    expect(tokens()).toHaveLength(1)
    await expect(newsletter.confirm({ token: messages[0]!.token }))
      .resolves.toEqual({ confirmed: true })
  })
})

describe('durable confirmation retries', () => {
  it.each(['token-generation', 'token-persistence', 'provider-rejection', 'provider-timeout'] as const)(
    'resumes failed re-subscription after %s from another service instance',
    async failure => {
      const { newsletter, createInstance, mailer, messages, waitForEvents, advance } = setup()
      await newsletter.subscribe(signup)
      await waitForEvents(NEWSLETTER_EVENT_TYPES.CONFIRMATION_SENT, 1)
      const single = (await newsletter.createUnsubscribeCapability({ email }))!
      const all = (await newsletter.createUnsubscribeCapability({ email, all: true }))!
      await newsletter.unsubscribe({ capability: single })

      if (failure === 'token-generation') {
        vi.spyOn(newsletter.tokenGenerator, 'generate')
          .mockImplementationOnce(() => { throw new Error('entropy unavailable') })
      } else if (failure === 'token-persistence') {
        vi.spyOn(newsletter.capabilities, 'replaceConfirmation')
          .mockRejectedValueOnce(new Error('token store unavailable'))
      } else if (failure === 'provider-rejection') {
        mailer.sendConfirmation.mockResolvedValueOnce({ accepted: false })
      } else {
        mailer.sendConfirmation.mockRejectedValueOnce(new Error('provider timeout'))
      }
      await expect(newsletter.subscribe(signup)).resolves.toEqual({ accepted: true })
      await waitForEvents(NEWSLETTER_EVENT_TYPES.CONFIRMATION_SEND_FAILED, 1)
      const pending = await newsletter.getSubscription({ email })
      expect(pending).toMatchObject({
        lifecycleGeneration: 2,
        confirmationSentAt: null,
        confirmationDelivery: failure === 'provider-timeout'
          ? { attemptId: expect.any(String), leaseExpiresAt: expect.any(Date) }
          : { attemptId: null, leaseExpiresAt: null }
      })

      const restarted = createInstance()
      await expect(restarted.unsubscribe({ capability: single }))
        .resolves.toEqual({ unsubscribed: false })
      await expect(restarted.unsubscribeAll({ capability: all }))
        .resolves.toEqual({ unsubscribed: false })
      if (failure === 'provider-timeout') advance(1_000)
      await restarted.subscribe({ ...signup, consent: { granted: true, version: 'ignored' } })
      await waitForEvents(NEWSLETTER_EVENT_TYPES.CONFIRMATION_SENT, 2)
      expect(await restarted.getSubscription({ email })).toMatchObject({
        lifecycleGeneration: 2,
        consent: { version: 'v1' },
        confirmationDelivery: null
      })
      await expect(restarted.confirm({ token: messages.at(-1)!.token }))
        .resolves.toEqual({ confirmed: true })
    }
  )

  it('keeps ambiguous provider tokens usable while bounding retained retry tokens', async () => {
    const { newsletter, tokens, messages, mailer, waitForEvents, advance } = setup()
    mailer.sendConfirmation.mockImplementation(async input => {
      messages.push(input)
      throw new Error('delivery may have succeeded')
    })
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      if (attempt > 1) advance(1_000)
      await newsletter.subscribe(signup)
      await waitForEvents(NEWSLETTER_EVENT_TYPES.CONFIRMATION_SEND_FAILED, attempt)
    }
    expect(tokens().filter(record =>
      record.consumedAt == null && record.revokedAt == null
    )).toHaveLength(2)
    await expect(newsletter.confirm({ token: messages[0]!.token }))
      .resolves.toEqual({ confirmed: false })
    await expect(newsletter.confirm({ token: messages[1]!.token }))
      .resolves.toEqual({ confirmed: true })
  })

  it.each([
    ['accepted', { accepted: true }, 'ACCEPTED'],
    ['temporary', { accepted: false, failure: MAIL_DELIVERY_FAILURES.TEMPORARY }, 'TEMPORARY'],
    ['permanent', { accepted: false, failure: MAIL_DELIVERY_FAILURES.PERMANENT }, 'PERMANENT'],
    ['ambiguous', { accepted: false, failure: MAIL_DELIVERY_FAILURES.AMBIGUOUS }, 'AMBIGUOUS']
  ] as const)(
    'reclaims an expired lease and records a late %s result of the older attempt as stale',
    async (_, oldResult, outcome) => {
      const { newsletter, createInstance, mailer, messages, advance, settle } = setup()
      const oldSend = gate()
      const newSend = gate()
      mailer.sendConfirmation
        .mockImplementationOnce(async input => {
          messages.push(input)
          await oldSend.promise
          return oldResult
        })
        .mockImplementationOnce(async input => {
          messages.push(input)
          await newSend.promise
          return { accepted: true }
        })
      const eventsOf = async (type: string) =>
        (await newsletter.listEvents({ email })).filter(event => event.type === type)

      await newsletter.subscribe(signup)
      await vi.waitFor(() => expect(messages).toHaveLength(1))
      const previous = (await newsletter.getSubscription({ email }))!.confirmationDelivery!
      const other = createInstance()
      try {
        advance(999)
        await Promise.all([other.subscribe(signup), other.subscribe(signup)])
        await other.resendConfirmation({ email })
        await settle(other)
        expect(messages).toHaveLength(1)
        advance(1)
        await other.subscribe(signup)
        await vi.waitFor(() => expect(messages).toHaveLength(2))
        const current = (await other.getSubscription({ email }))!.confirmationDelivery!
        expect(current.id).toBe(previous.id)
        expect(current.attemptId).not.toBe(previous.attemptId)

        oldSend.release()
        await settle()
        expect(await eventsOf(NEWSLETTER_EVENT_TYPES.CONFIRMATION_STALE_RESULT)).toEqual([
          expect.objectContaining({
            metadata: expect.objectContaining({
              deliveryId: previous.id,
              attemptId: previous.attemptId,
              lifecycleGeneration: 1,
              authoritative: false,
              outcome
            })
          })
        ])
        expect(await eventsOf(NEWSLETTER_EVENT_TYPES.CONFIRMATION_SENT)).toEqual([])
        expect(await eventsOf(NEWSLETTER_EVENT_TYPES.CONFIRMATION_SEND_FAILED)).toEqual([])
        expect(await other.getSubscription({ email })).toMatchObject({
          confirmationDelivery: current,
          confirmationSentAt: null
        })
      } finally {
        oldSend.release()
        newSend.release()
      }
      await settle(other)
      expect(await eventsOf(NEWSLETTER_EVENT_TYPES.CONFIRMATION_SENT)).toEqual([
        expect.objectContaining({
          metadata: expect.objectContaining({
            deliveryId: previous.id,
            attemptId: messages[1]!.attemptId,
            lifecycleGeneration: 1,
            authoritative: true,
            outcome: 'ACCEPTED'
          })
        })
      ])
      expect(await eventsOf(NEWSLETTER_EVENT_TYPES.CONFIRMATION_STALE_RESULT)).toHaveLength(1)
      expect(await other.getSubscription({ email })).toMatchObject({
        confirmationDelivery: null,
        confirmationSentAt: expect.any(Date)
      })
      await expect(other.confirm({ token: messages[1]!.token }))
        .resolves.toEqual({ confirmed: true })
    }
  )

  it('records a result as stale once the subscription was confirmed meanwhile', async () => {
    const { newsletter, mailer, messages, advance, waitForEvents, settle } = setup()
    await newsletter.subscribe(signup)
    await waitForEvents(NEWSLETTER_EVENT_TYPES.CONFIRMATION_SENT, 1)
    const send = gate()
    mailer.sendConfirmation.mockImplementationOnce(async input => {
      messages.push(input)
      await send.promise
      throw new Error('provider timeout')
    })

    advance(1)
    await newsletter.resendConfirmation({ email })
    await vi.waitFor(() => expect(messages).toHaveLength(2))
    await expect(newsletter.confirm({ token: messages[0]!.token }))
      .resolves.toEqual({ confirmed: true })
    send.release()
    await settle()

    expect((await newsletter.listEvents({ email })).at(-1)).toMatchObject({
      type: NEWSLETTER_EVENT_TYPES.CONFIRMATION_STALE_RESULT,
      metadata: {
        attemptId: messages[1]!.attemptId,
        authoritative: false,
        outcome: 'AMBIGUOUS',
        stage: 'DELIVERY'
      }
    })
    expect(await newsletter.getSubscription({ email })).toMatchObject({
      status: SUBSCRIPTION_STATUSES.ACTIVE,
      confirmationDelivery: null
    })
  })

  it('recovers when delivery succeeds but recording the result rolls back', async () => {
    const { newsletter, createInstance, storage, advance, waitForEvents, messages } = setup()
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const failing = createInstance({
      transaction: operation => storage.transaction(transaction => operation({
        ...transaction,
        async appendEvent(event) {
          if (event.type === NEWSLETTER_EVENT_TYPES.CONFIRMATION_SENT) throw new Error('commit failed')
          await transaction.appendEvent(event)
        }
      }))
    })
    try {
      await failing.subscribe(signup)
      await vi.waitFor(() => expect(log).toHaveBeenCalledOnce())
      const pending = await newsletter.getSubscription({ email })
      expect(pending?.confirmationSentAt).toBeNull()
      expect(pending?.confirmationDelivery?.attemptId).not.toBeNull()
      advance(1_001)
      await newsletter.subscribe(signup)
      await waitForEvents(NEWSLETTER_EVENT_TYPES.CONFIRMATION_SENT, 1)
      expect(messages).toHaveLength(2)
      await expect(newsletter.confirm({ token: messages[0]!.token }))
        .resolves.toEqual({ confirmed: true })
    } finally {
      log.mockRestore()
    }
  })

  it('does not consume a confirmation when activation rolls back after the update', async () => {
    const { newsletter, createInstance, storage, messages, waitForEvents } = setup()
    await newsletter.subscribe(signup)
    await waitForEvents(NEWSLETTER_EVENT_TYPES.CONFIRMATION_SENT, 1)
    const failing = createInstance({
      transaction: operation => storage.transaction(transaction => operation({
        ...transaction,
        async appendEvent(event) {
          if (event.type === NEWSLETTER_EVENT_TYPES.CONFIRMED) throw new Error('commit failed')
          await transaction.appendEvent(event)
        }
      }))
    })
    await expect(failing.confirm({ token: messages[0]!.token })).rejects.toThrow('commit failed')
    await expect(newsletter.confirm({ token: messages[0]!.token }))
      .resolves.toEqual({ confirmed: true })
  })
})

describe('storage conflicts', () => {
  it('re-runs a signup whose stale read lost a unique-constraint race', async () => {
    const { newsletter, createInstance, storage, waitForEvents } = setup()
    await newsletter.subscribe(signup)
    await waitForEvents(NEWSLETTER_EVENT_TYPES.CONFIRMATION_SENT, 1)
    const staleAll = (await newsletter.createUnsubscribeCapability({ email, all: true }))!
    let staleReads = 1
    const racing = createInstance({
      transaction: operation => storage.transaction(transaction => operation({
        ...transaction,
        // Simulates a read that missed a concurrently committed contact.
        async getContactByEmail(value) {
          if (staleReads > 0) {
            staleReads -= 1
            return null
          }
          return transaction.getContactByEmail(value)
        }
      }))
    })

    await expect(racing.subscribe({ ...signup, audience: 'product-news' }))
      .resolves.toEqual({ accepted: true })
    expect(staleReads).toBe(0)
    expect(await newsletter.listSubscriptions({ email })).toHaveLength(2)
    expect(await newsletter.getContact({ email }))
      .toMatchObject({ capabilityGeneration: 2 })
    await expect(newsletter.unsubscribeAll({ capability: staleAll }))
      .resolves.toEqual({ unsubscribed: false })
  })

  it.each([undefined, 1, 5])('gives up after the configured attempts: %s', async maxAttempts => {
    let calls = 0
    const newsletter = betterNewsletter({
      storage: {
        async transaction() {
          calls += 1
          throw new StorageConflictError('serialization failure')
        }
      },
      capabilities: createSecureCapabilities({ hmacSecret: secret }),
      mailer: { async sendConfirmation() { return { accepted: true } } },
      ...(maxAttempts !== undefined ? { transactionMaxAttempts: maxAttempts } : {})
    })

    await expect(newsletter.subscribe(signup)).rejects.toBeInstanceOf(StorageConflictError)
    expect(calls).toBe(maxAttempts ?? 3)
  })

  it('does not retry non-conflict storage errors', async () => {
    let calls = 0
    const newsletter = betterNewsletter({
      storage: {
        async transaction() {
          calls += 1
          throw new Error('connection lost')
        }
      },
      capabilities: createSecureCapabilities({ hmacSecret: secret }),
      mailer: { async sendConfirmation() { return { accepted: true } } }
    })

    await expect(newsletter.subscribe(signup)).rejects.toThrow('connection lost')
    expect(calls).toBe(1)
  })

  it('reads the contact before subscriptions in every transaction', async () => {
    const { createInstance, storage, messages, advance } = setup()
    const violations: string[] = []
    const ordered = createInstance({
      transaction: operation => storage.transaction(transaction => {
        let subscriptionRead = false
        const readContact = (name: string) => {
          if (subscriptionRead) violations.push(name)
        }
        return operation({
          ...transaction,
          async getContactById(id) {
            readContact('getContactById')
            return transaction.getContactById(id)
          },
          async getContactByEmail(value) {
            readContact('getContactByEmail')
            return transaction.getContactByEmail(value)
          },
          async getSubscriptionById(id) {
            subscriptionRead = true
            return transaction.getSubscriptionById(id)
          },
          async getSubscription(contactId, audienceKey) {
            subscriptionRead = true
            return transaction.getSubscription(contactId, audienceKey)
          },
          async listSubscriptions(contactId) {
            subscriptionRead = true
            return transaction.listSubscriptions(contactId)
          }
        })
      })
    })
    const settleOrdered = async () => {
      await vi.waitFor(async () => {
        const events = await ordered.listEvents({ email })
        const requested = events.filter(event =>
          event.type === NEWSLETTER_EVENT_TYPES.CONFIRMATION_REQUESTED).length
        const completed = events.filter(event =>
          event.type === NEWSLETTER_EVENT_TYPES.CONFIRMATION_SENT
          || event.type === NEWSLETTER_EVENT_TYPES.CONFIRMATION_SEND_FAILED).length
        expect(completed).toBe(requested)
      })
    }

    await ordered.subscribe(signup)
    await settleOrdered()
    advance(1)
    await ordered.resendConfirmation({ email })
    await settleOrdered()
    await ordered.confirm({ token: messages.at(-1)!.token })
    await ordered.subscribe({ ...signup, audience: 'product-news' })
    await settleOrdered()
    const single = (await ordered.createUnsubscribeCapability({ email }))!
    await ordered.unsubscribe({ capability: single })
    const all = (await ordered.createUnsubscribeCapability({ email, all: true }))!
    await ordered.unsubscribeAll({ capability: all })
    await ordered.suppressContact({ email, reason: 'BOUNCE' })
    await ordered.unsuppressContact({ email })
    await ordered.importSubscription({
      email,
      audience: 'legacy',
      status: SUBSCRIPTION_STATUSES.ACTIVE,
      consent: { version: 'legacy', consentedAt: new Date(0) },
      confirmedAt: new Date(1)
    })

    expect(messages.length).toBeGreaterThanOrEqual(3)
    expect(violations).toEqual([])
  })
})

describe('delivery outcomes', () => {
  it('passes the claimed delivery and attempt IDs to the mailer', async () => {
    const { newsletter, messages, waitForEvents, settle } = setup()
    await newsletter.subscribe(signup)
    await waitForEvents(NEWSLETTER_EVENT_TYPES.CONFIRMATION_SENT, 1)
    await newsletter.resendConfirmation({ email })
    await settle()

    const requested = (await newsletter.listEvents({ email }))
      .filter(event => event.type === NEWSLETTER_EVENT_TYPES.CONFIRMATION_REQUESTED)
      .map(event => event.metadata.attemptId)
    expect(messages).toHaveLength(2)
    expect(messages.map(message => message.attemptId)).toEqual(requested)
    expect(messages.map(message => message.subscription.confirmationDelivery?.attemptId))
      .toEqual(requested)
    expect(messages.map(message => message.subscription.confirmationDelivery?.id))
      .toEqual(messages.map(message => message.deliveryId))
    expect(messages[0]!.deliveryId).not.toBe(messages[1]!.deliveryId)
    expect(messages[0]).toMatchObject({ audienceKey: 'default', lifecycleGeneration: 1 })
  })

  it('holds an ambiguous claim until its lease expires and then retries the same work', async () => {
    const { newsletter, mailer, messages, advance, settle } = setup()
    mailer.sendConfirmation.mockImplementationOnce(async input => {
      messages.push(input)
      return { accepted: false, failure: MAIL_DELIVERY_FAILURES.AMBIGUOUS }
    })
    await newsletter.subscribe(signup)
    await settle()

    expect((await newsletter.getSubscription({ email }))?.confirmationDelivery)
      .toMatchObject({ attemptId: messages[0]!.attemptId, leaseExpiresAt: expect.any(Date) })
    expect((await newsletter.listEvents({ email })).at(-1)).toMatchObject({
      type: NEWSLETTER_EVENT_TYPES.CONFIRMATION_SEND_FAILED,
      metadata: { outcome: MAIL_DELIVERY_FAILURES.AMBIGUOUS, stage: 'DELIVERY', authoritative: true }
    })

    await newsletter.resendConfirmation({ email })
    await settle()
    expect(messages).toHaveLength(1)

    advance(1_000)
    await newsletter.resendConfirmation({ email })
    await settle()
    expect(messages).toHaveLength(2)
    expect(messages[1]!.deliveryId).toBe(messages[0]!.deliveryId)
    expect(messages[1]!.attemptId).not.toBe(messages[0]!.attemptId)
    expect(messages[1]!.token).not.toBe(messages[0]!.token)
    await expect(newsletter.confirm({ token: messages[0]!.token }))
      .resolves.toEqual({ confirmed: true })
  })

  it('drops permanently rejected work until an explicit resend', async () => {
    const { newsletter, mailer, messages, settle } = setup()
    mailer.sendConfirmation.mockImplementationOnce(async input => {
      messages.push(input)
      return { accepted: false, failure: MAIL_DELIVERY_FAILURES.PERMANENT, reason: MAIL_DELIVERY_REASONS.INVALID_REQUEST }
    })
    await newsletter.subscribe(signup)
    await settle()

    expect((await newsletter.getSubscription({ email }))?.confirmationDelivery).toBeNull()
    expect((await newsletter.listEvents({ email })).at(-1)).toMatchObject({
      type: NEWSLETTER_EVENT_TYPES.CONFIRMATION_SEND_FAILED,
      metadata: { outcome: MAIL_DELIVERY_FAILURES.PERMANENT, reason: MAIL_DELIVERY_REASONS.INVALID_REQUEST, authoritative: true }
    })

    await newsletter.subscribe(signup)
    await settle()
    expect(messages).toHaveLength(1)

    await newsletter.resendConfirmation({ email })
    await settle()
    expect(messages).toHaveLength(2)
    expect(messages[1]!.deliveryId).not.toBe(messages[0]!.deliveryId)
  })

  it('releases the claim when the contact is suppressed before token setup', async () => {
    const { newsletter, messages, settle } = setup()
    const started = gate()
    const resume = gate()
    const generate = newsletter.tokenGenerator.generate
    vi.spyOn(newsletter.tokenGenerator, 'generate').mockImplementationOnce(async () => {
      started.release()
      await resume.promise
      return generate()
    })

    await newsletter.subscribe(signup)
    await started.promise
    await newsletter.suppressContact({ email, reason: 'COMPLAINT' })
    resume.release()
    await settle()

    expect(messages).toHaveLength(0)
    expect((await newsletter.getSubscription({ email }))?.confirmationDelivery)
      .toMatchObject({ attemptId: null, leaseExpiresAt: null })
    expect((await newsletter.listEvents({ email })).at(-1)).toMatchObject({
      type: NEWSLETTER_EVENT_TYPES.CONFIRMATION_SEND_FAILED,
      metadata: { stage: 'ELIGIBILITY', authoritative: true }
    })

    await newsletter.unsuppressContact({ email })
    await newsletter.resendConfirmation({ email })
    await settle()
    expect(messages).toHaveLength(1)
  })

  it('answers resend before delivery finishes', async () => {
    const { newsletter, mailer, messages, waitForEvents, settle } = setup()
    await newsletter.subscribe(signup)
    await waitForEvents(NEWSLETTER_EVENT_TYPES.CONFIRMATION_SENT, 1)
    const send = gate()
    mailer.sendConfirmation.mockImplementationOnce(async input => {
      messages.push(input)
      await send.promise
      return { accepted: true }
    })

    try {
      await expect(newsletter.resendConfirmation({ email }))
        .resolves.toEqual({ accepted: true })
      await vi.waitFor(() => expect(messages).toHaveLength(2))
      expect((await newsletter.listEvents({ email }))
        .filter(event => event.type === NEWSLETTER_EVENT_TYPES.CONFIRMATION_SENT))
        .toHaveLength(1)
    } finally {
      send.release()
    }
    await settle()
    await waitForEvents(NEWSLETTER_EVENT_TYPES.CONFIRMATION_SENT, 2)
  })
})
