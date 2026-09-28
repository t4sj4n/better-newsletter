import { describe, expect, it, vi } from 'vitest'
import {
  CONFIRMATION_REPLACEMENT_STRATEGIES,
  NEWSLETTER_EVENT_TYPES,
  SUBSCRIPTION_STATUSES,
  createNewsletter,
  createSecureCapabilities,
  type ConfirmationMailInput,
  type ConfirmationOptions,
  type NewsletterStorage
} from '../src/index.js'
import { memoryConfirmationTokenStore, memoryStorage } from '../src/memory.js'

const email = 'person@example.com'
const signup = { email, consent: { granted: true, version: 'v1' } }
const secret = '0123456789abcdef0123456789abcdef'

function gate() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}

function setup(confirmation: ConfirmationOptions = {}) {
  let nowMs = Date.parse('2026-09-28T10:00:00.000Z')
  let token = 0
  const storage = memoryStorage()
  const confirmationStore = memoryConfirmationTokenStore()
  const messages: ConfirmationMailInput[] = []
  const mailer = {
    sendConfirmation: vi.fn(async (input: ConfirmationMailInput) => {
      messages.push(input)
      return { accepted: true }
    })
  }
  const createInstance = (instanceStorage: NewsletterStorage = storage) => createNewsletter({
    storage: instanceStorage,
    capabilities: createSecureCapabilities({ confirmationStore, hmacSecret: secret }),
    mailer,
    tokenGenerator: { generate: (): string | Promise<string> => `token-${++token}` },
    clock: { now: () => new Date(nowMs) },
    confirmation: { deliveryLeaseMs: 1_000, ...confirmation }
  })
  const newsletter = createInstance()
  const waitForEvents = async (type: string, count: number) => {
    await vi.waitFor(async () => {
      const events = await newsletter.listEvents({ email })
      expect(events.filter(event => event.type === type)).toHaveLength(count)
    })
  }
  return {
    newsletter, createInstance, storage, confirmationStore, mailer, messages, waitForEvents,
    advance: (ms: number) => { nowMs += ms }
  }
}

describe('generation-bound lifecycle concurrency', () => {
  it.each(['confirm', 'unsubscribe', 'unsubscribeAll'] as const)(
    'rejects an old resolved %s target after another instance starts a new cycle',
    async action => {
      const { newsletter, createInstance, messages, waitForEvents } = setup()
      await newsletter.subscribe(signup)
      await waitForEvents(NEWSLETTER_EVENT_TYPES.CONFIRMATION_SENT, 1)
      const single = (await newsletter.createUnsubscribeCapability({ email }))!
      const all = (await newsletter.createUnsubscribeCapability({ email, all: true }))!
      const reader = createInstance()
      const resolved = gate()
      const resume = gate()

      if (action === 'confirm') {
        const original = reader.capabilities.resolveConfirmation
        vi.spyOn(reader.capabilities, 'resolveConfirmation').mockImplementationOnce(async (...args) => {
          const target = await original(...args)
          expect(target?.lifecycleGeneration).toBe(1)
          resolved.release()
          await resume.promise
          return target
        })
      } else {
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
      const { newsletter, createInstance, messages, advance, waitForEvents } = setup({
        expiresInMs: 1_000,
        replacementStrategy: CONFIRMATION_REPLACEMENT_STRATEGIES.REPLACE_PREVIOUS
      })
      await newsletter.subscribe(signup)
      await waitForEvents(NEWSLETTER_EVENT_TYPES.CONFIRMATION_SENT, 1)
      const reader = createInstance()
      const resolved = gate()
      const resume = gate()
      const original = reader.capabilities.resolveConfirmation
      vi.spyOn(reader.capabilities, 'resolveConfirmation').mockImplementationOnce(async (...args) => {
        const target = await original(...args)
        resolved.release()
        await resume.promise
        return target
      })
      const confirming = reader.confirm({ token: messages[0]!.token })
      try {
        await resolved.promise
        if (invalidation === 'expiry') {
          advance(1_000)
        } else {
          await newsletter.resendConfirmation({ email })
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
    const { newsletter, createInstance, confirmationStore, messages, waitForEvents } = setup()
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
    expect(confirmationStore.snapshot()).toHaveLength(2)
    expect(messages).toHaveLength(2)
    expect(messages[1]!.subscription.lifecycleGeneration).toBe(2)
    await expect(other.confirm({ token: messages[1]!.token }))
      .resolves.toEqual({ confirmed: true })
  })

  it('fences stale same-generation setup before it can replace a newer delivered token', async () => {
    const { newsletter, createInstance, messages, advance, waitForEvents } = setup({
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
      expect(messages).toHaveLength(2)
    } finally {
      resume.release()
    }
    await oldResend
    expect(messages).toHaveLength(2)
    await expect(other.confirm({ token: messages[1]!.token }))
      .resolves.toEqual({ confirmed: true })
  })

  it('scopes delayed confirmation revocation to the old generation', async () => {
    const { newsletter, createInstance, messages, waitForEvents } = setup()
    await newsletter.subscribe(signup)
    await waitForEvents(NEWSLETTER_EVENT_TYPES.CONFIRMATION_SENT, 1)
    const oldCapability = (await newsletter.createUnsubscribeCapability({ email }))!
    const started = gate()
    const resume = gate()
    const revoke = newsletter.capabilities.revokeConfirmations
    vi.spyOn(newsletter.capabilities, 'revokeConfirmations').mockImplementationOnce(async (...args) => {
      started.release()
      await resume.promise
      return revoke(...args)
    })
    const unsubscribe = newsletter.unsubscribe({ capability: oldCapability })
    const other = createInstance()
    try {
      await started.promise
      await other.subscribe(signup)
      await waitForEvents(NEWSLETTER_EVENT_TYPES.CONFIRMATION_SENT, 2)
    } finally {
      resume.release()
    }
    await unsubscribe
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

describe('durable confirmation retries', () => {
  it.each(['token-generation', 'token-persistence', 'provider-rejection', 'provider-timeout'] as const)(
    'resumes failed re-subscription after %s from another service instance',
    async failure => {
      const { newsletter, createInstance, mailer, messages, waitForEvents } = setup()
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
        confirmationDelivery: { attemptId: null, leaseExpiresAt: null }
      })

      const restarted = createInstance()
      await expect(restarted.unsubscribe({ capability: single }))
        .resolves.toEqual({ unsubscribed: false })
      await expect(restarted.unsubscribeAll({ capability: all }))
        .resolves.toEqual({ unsubscribed: false })
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
    const { newsletter, confirmationStore, messages, mailer, waitForEvents } = setup()
    mailer.sendConfirmation.mockImplementation(async input => {
      messages.push(input)
      throw new Error('delivery may have succeeded')
    })
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await newsletter.subscribe(signup)
      await waitForEvents(NEWSLETTER_EVENT_TYPES.CONFIRMATION_SEND_FAILED, attempt)
    }
    expect(confirmationStore.snapshot().filter(record =>
      record.consumedAt == null && record.revokedAt == null
    )).toHaveLength(2)
    await expect(newsletter.confirm({ token: messages[0]!.token }))
      .resolves.toEqual({ confirmed: false })
    await expect(newsletter.confirm({ token: messages[1]!.token }))
      .resolves.toEqual({ confirmed: true })
  })

  it('reclaims expired delivery leases and fences late completion of an older attempt', async () => {
    const { newsletter, createInstance, mailer, messages, advance, waitForEvents } = setup()
    const oldSend = gate()
    const newSend = gate()
    mailer.sendConfirmation
      .mockImplementationOnce(async input => {
        messages.push(input)
        await oldSend.promise
        return { accepted: true }
      })
      .mockImplementationOnce(async input => {
        messages.push(input)
        await newSend.promise
        return { accepted: true }
      })

    await newsletter.subscribe(signup)
    await vi.waitFor(() => expect(messages).toHaveLength(1))
    const previous = (await newsletter.getSubscription({ email }))!.confirmationDelivery!
    const other = createInstance()
    try {
      advance(999)
      await Promise.all([other.subscribe(signup), other.subscribe(signup)])
      await other.resendConfirmation({ email })
      expect(messages).toHaveLength(1)
      advance(1)
      await other.subscribe(signup)
      await vi.waitFor(() => expect(messages).toHaveLength(2))
      const current = (await other.getSubscription({ email }))!.confirmationDelivery!
      expect(current.id).toBe(previous.id)
      expect(current.attemptId).not.toBe(previous.attemptId)

      oldSend.release()
      await waitForEvents(NEWSLETTER_EVENT_TYPES.CONFIRMATION_SENT, 1)
      expect((await other.getSubscription({ email }))!.confirmationDelivery)
        .toEqual(current)
    } finally {
      oldSend.release()
      newSend.release()
    }
    await waitForEvents(NEWSLETTER_EVENT_TYPES.CONFIRMATION_SENT, 2)
    expect((await other.getSubscription({ email }))!.confirmationDelivery).toBeNull()
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
