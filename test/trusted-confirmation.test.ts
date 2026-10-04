import { describe, expect, it, vi } from 'vitest'
import {
  betterNewsletter,
  NEWSLETTER_EVENT_TYPES,
  StorageConflictError,
  type ConfirmationOptions
} from '../packages/better-newsletter/src/index.js'
import { memoryAdapter } from '../packages/better-newsletter/src/adapters/memory.js'
import { createSecureCapabilities, sha256Digest } from '../packages/better-newsletter/src/security.js'
import type { NewsletterStorage } from '../packages/better-newsletter/src/storage.js'

const email = 'person@example.com'
const now = new Date('2026-10-01T10:00:00Z')

async function fixture(confirmation: ConfirmationOptions = {}) {
  const storage = memoryAdapter()
  const mailer = { sendConfirmation: vi.fn(async () => ({ accepted: true })) }
  let time = now.getTime()
  const options = {
    storage, mailer,
    capabilities: createSecureCapabilities({ hmacSecret: '0123456789abcdef0123456789abcdef' }),
    clock: { now: () => new Date(time) }, confirmation
  }
  const newsletter = betterNewsletter(options)
  const subscription = await newsletter.importSubscription({
    email, status: 'PENDING_CONFIRMATION',
    consent: { version: 'v1', consentedAt: now }
  })
  const input = { subscription: { id: subscription.id } }
  return { storage, mailer, options, newsletter, subscription, input, advance: (ms: number) => { time += ms } }
}

describe('trusted confirmation APIs', () => {
  it.each([
    ['RETAIN_PREVIOUS_UNTIL_EXPIRY', undefined, true],
    ['RETAIN_PREVIOUS_UNTIL_EXPIRY', 'REPLACE_PREVIOUS', false],
    ['REPLACE_PREVIOUS', undefined, false],
    ['REPLACE_PREVIOUS', 'RETAIN_PREVIOUS_UNTIL_EXPIRY', true]
  ] as const)('applies global %s and per-call %s without changing configuration', async (global, override, retained) => {
    const { newsletter, storage, subscription, input, mailer, options } = await fixture({
      replacementStrategy: global, maxActiveTokens: 4
    })
    const first = (await newsletter.createConfirmationToken(input))!
    const second = (await newsletter.createConfirmationToken({
      ...input,
      ...(override === undefined ? {} : { replacementStrategy: override }),
      eventMetadata: { actorId: 'admin-123', audienceKey: 'forged', lifecycleGeneration: 999 }
    }))!
    expect(storage.confirmationTokenSnapshot()[0]!.revokedAt == null).toBe(retained)
    const audit = (await newsletter.listEvents({ email })).find(event =>
      event.type === 'CONFIRMATION_TOKEN_CREATED' && event.metadata?.actorId === 'admin-123'
    )!
    expect(audit.metadata).toEqual({
      actorId: 'admin-123', audienceKey: subscription.audienceKey,
      lifecycleGeneration: subscription.lifecycleGeneration
    })
    expect(JSON.stringify(audit)).not.toContain(second.token)
    expect(JSON.stringify(audit)).not.toContain(await sha256Digest(second.token))
    expect(options.confirmation.replacementStrategy).toBe(global)
    expect(mailer.sendConfirmation).not.toHaveBeenCalled()
    expect(await newsletter.confirm({ token: first.token })).toEqual({ confirmed: retained })
    if (!retained) expect(await newsletter.confirm({ token: second.token })).toEqual({ confirmed: true })
  })

  it.each(['RETAIN_PREVIOUS_UNTIL_EXPIRY', 'REPLACE_PREVIOUS'] as const)(
    'keeps public signup/resend on the global %s strategy after a trusted override', async global => {
      const { options, input, storage, mailer } = await fixture({ replacementStrategy: global, maxActiveTokens: 4 })
      const tasks: Promise<void>[] = []
      const newsletter = betterNewsletter({ ...options, runBackground: task => { tasks.push(task) } })
      const replace = vi.spyOn(options.capabilities, 'replaceConfirmation')
      const override = global === 'REPLACE_PREVIOUS' ? 'RETAIN_PREVIOUS_UNTIL_EXPIRY' : 'REPLACE_PREVIOUS'
      const admin = (await newsletter.createConfirmationToken({ ...input, replacementStrategy: override }))!
      await newsletter.subscribe({ email: 'signup@example.com', consent: { granted: true, version: 'v1' } })
      await Promise.all(tasks.splice(0))
      await newsletter.resendConfirmation({ email })
      await Promise.all(tasks.splice(0))
      expect(mailer.sendConfirmation).toHaveBeenCalledTimes(2)
      const records = storage.confirmationTokenSnapshot()
      expect(replace.mock.calls.map(([input]) => input.replacementStrategy)).toEqual([override, global, global])
      expect(records).toHaveLength(3)
      expect(records[0]!.revokedAt == null).toBe(global === 'RETAIN_PREVIOUS_UNTIL_EXPIRY')
      expect(records[1]!.revokedAt).toBeNull()
      expect(records[2]!.revokedAt).toBeNull()
      expect(await newsletter.confirm({ token: admin.token })).toEqual({ confirmed: global === 'RETAIN_PREVIOUS_UNTIL_EXPIRY' })
    }
  )

  it('issues a digest-only token with configured expiry, records an event and confirms without mail', async () => {
    const { newsletter, storage, mailer, subscription, input } = await fixture({ expiresInMs: 60_000 })
    expect(await newsletter.getConfirmationState(input)).toEqual({
      canCreate: true, reason: null, activeTokenExpiresAt: null
    })
    const result = await newsletter.createConfirmationToken(input)
    expect(result!.token).toMatch(/^[a-f0-9]{64}$/u)
    expect(result!.expiresAt).toEqual(new Date(now.getTime() + 60_000))
    expect(storage.confirmationTokenSnapshot()).toMatchObject([{
      digest: await sha256Digest(result!.token), contactId: subscription.contactId,
      subscriptionId: subscription.id, lifecycleGeneration: subscription.lifecycleGeneration,
      expiresAt: result!.expiresAt
    }])
    expect(JSON.stringify(storage.confirmationTokenSnapshot())).not.toContain(result!.token)
    const state = await newsletter.getConfirmationState({ subscription: { email: ' PERSON@example.com ' } })
    expect(state).toEqual({ canCreate: true, reason: null, activeTokenExpiresAt: result!.expiresAt })
    expect(Object.keys(state!).sort()).toEqual(['activeTokenExpiresAt', 'canCreate', 'reason'])
    const event = (await newsletter.listEvents({ email })).at(-1)!
    expect(event).toMatchObject({
      type: NEWSLETTER_EVENT_TYPES.CONFIRMATION_TOKEN_CREATED,
      subscriptionId: subscription.id, metadata: { lifecycleGeneration: 1 }
    })
    expect(JSON.stringify(event)).not.toContain(result!.token)
    expect(await newsletter.confirm({ token: result!.token })).toEqual({ confirmed: true })
    expect(await newsletter.confirm({ token: result!.token })).toEqual({ confirmed: false })
    expect(await newsletter.getConfirmationState(input)).toEqual({
      canCreate: false, reason: 'ACTIVE', activeTokenExpiresAt: null
    })
    expect(mailer.sendConfirmation).not.toHaveBeenCalled()
  })

  it('persists host audit metadata while keeping system fields authoritative', async () => {
    const { newsletter, input, subscription, mailer } = await fixture()
    await newsletter.createConfirmationToken({
      ...input,
      eventMetadata: { actorId: 'admin-123', source: 'admin-ui', audienceKey: 'fake', lifecycleGeneration: 999 }
    })
    expect((await newsletter.listEvents({ email })).at(-1)).toMatchObject({
      type: 'CONFIRMATION_TOKEN_CREATED',
      metadata: {
        actorId: 'admin-123', source: 'admin-ui',
        audienceKey: subscription.audienceKey, lifecycleGeneration: subscription.lifecycleGeneration
      }
    })
    expect(mailer.sendConfirmation).not.toHaveBeenCalled()
  })

  it.each(['REPLACE_PREVIOUS', 'RETAIN_PREVIOUS_UNTIL_EXPIRY'] as const)(
    'audit metadata does not affect the %s lifecycle', async replacementStrategy => {
      const { newsletter, options, storage, input, subscription, mailer } = await fixture({
        replacementStrategy, maxActiveTokens: 2, expiresInMs: 60_000
      })
      let next = 0
      const service = betterNewsletter({ ...options, tokenGenerator: { generate: () => `audit-token-${++next}` } })
      const first = (await service.createConfirmationToken(input))!
      const second = (await service.createConfirmationToken({
        ...input,
        eventMetadata: {
          actorId: 'admin-123', status: 'ACTIVE', contactStatus: 'SUPPRESSED',
          expiresInMs: 1, replacementStrategy: 'fake', maxActiveTokens: 0,
          lifecycleGeneration: 999, digest: 'fake', token: 'fake'
        }
      }))!
      expect(first.expiresAt).toEqual(new Date(now.getTime() + 60_000))
      expect(second).toEqual({ token: 'audit-token-2', expiresAt: first.expiresAt })
      const records = storage.confirmationTokenSnapshot()
      expect(records[1]).toMatchObject({
        digest: await sha256Digest(second.token),
        lifecycleGeneration: subscription.lifecycleGeneration, expiresAt: second.expiresAt
      })
      expect(records[0]!.revokedAt != null).toBe(replacementStrategy === 'REPLACE_PREVIOUS')
      expect(await service.getConfirmationState(input)).toEqual({
        canCreate: true, reason: null, activeTokenExpiresAt: second.expiresAt
      })
      const events = await newsletter.listEvents({ email })
      expect(events.find(e => e.type === 'CONFIRMATION_TOKEN_CREATED')!.metadata).toEqual({
        audienceKey: subscription.audienceKey, lifecycleGeneration: subscription.lifecycleGeneration
      })
      for (const event of events.filter(e => e.type === 'CONFIRMATION_REPLACED')) {
        expect(event.metadata).not.toHaveProperty('actorId')
      }
      expect(await service.confirm({ token: second.token })).toEqual({ confirmed: true })
      expect(mailer.sendConfirmation).not.toHaveBeenCalled()
    }
  )

  it.each(['ACTIVE', 'UNSUBSCRIBED'] as const)('suppression takes precedence over %s, even with audit metadata', async status => {
    const { newsletter, storage, subscription, input } = await fixture()
    await storage.transaction(tx => tx.updateSubscription(subscription.id, { status }))
    await newsletter.suppressContact({ email, reason: 'admin' })
    expect(await newsletter.getConfirmationState(input)).toEqual({
      canCreate: false, reason: 'SUPPRESSED', activeTokenExpiresAt: null
    })
    const events = await newsletter.listEvents({ email })
    expect(await newsletter.createConfirmationToken({
      ...input, eventMetadata: { canCreate: true, status: 'PENDING_CONFIRMATION', contactStatus: 'ENABLED' }
    })).toBeNull()
    expect(await newsletter.listEvents({ email })).toEqual(events)
    expect(storage.confirmationTokenSnapshot()).toHaveLength(0)
  })

  it('uses the targeted storage expiry lookup and skips it for blocked subscriptions', async () => {
    const { storage, newsletter, options, input, subscription } = await fixture()
    const result = (await newsletter.createConfirmationToken(input))!
    const lookup = vi.fn()
    const targeted: NewsletterStorage = {
      transaction: operation => storage.transaction(tx => operation({
        ...tx,
        async listContactTokenMetadata() { throw new Error('Introspection must not load token lists') },
        async getLatestUsableConfirmationExpiry(value) {
          lookup(value)
          return tx.getLatestUsableConfirmationExpiry(value)
        }
      }))
    }
    const service = betterNewsletter({ ...options, storage: targeted })
    expect(await service.getConfirmationState(input)).toEqual({
      canCreate: true, reason: null, activeTokenExpiresAt: result.expiresAt
    })
    expect(lookup).toHaveBeenCalledExactlyOnceWith({
      subscriptionId: subscription.id, lifecycleGeneration: subscription.lifecycleGeneration, now
    })
    for (const status of ['ACTIVE', 'UNSUBSCRIBED'] as const) {
      await storage.transaction(tx => tx.updateSubscription(subscription.id, { status }))
      expect(await service.getConfirmationState(input)).toEqual({
        canCreate: false, reason: status, activeTokenExpiresAt: null
      })
    }
    await newsletter.suppressContact({ email, reason: 'admin' })
    expect(await service.getConfirmationState(input)).toEqual({
      canCreate: false, reason: 'SUPPRESSED', activeTokenExpiresAt: null
    })
    expect(lookup).toHaveBeenCalledTimes(1)
  })

  it('returns null for missing subscriptions', async () => {
    const { newsletter } = await fixture()
    for (const subscription of [{ id: 'missing' }, { email: 'missing@example.com' }]) {
      expect(await newsletter.createConfirmationToken({ subscription })).toBeNull()
      expect(await newsletter.getConfirmationState({ subscription })).toBeNull()
    }
  })

  it.each(['ACTIVE', 'UNSUBSCRIBED', 'SUPPRESSED'] as const)('rejects %s without tokens, events or mail', async reason => {
    const { newsletter, storage, input, subscription, mailer } = await fixture()
    if (reason === 'SUPPRESSED') await newsletter.suppressContact({ email, reason: 'admin' })
    else await storage.transaction(tx => tx.updateSubscription(subscription.id, { status: reason }))
    const before = await newsletter.listEvents({ email })
    expect(await newsletter.getConfirmationState(input)).toEqual({
      canCreate: false, reason, activeTokenExpiresAt: null
    })
    expect(await newsletter.createConfirmationToken(input)).toBeNull()
    expect(storage.confirmationTokenSnapshot()).toHaveLength(0)
    expect(await newsletter.listEvents({ email })).toEqual(before)
    expect(mailer.sendConfirmation).not.toHaveBeenCalled()
  })

  it('replaces previous tokens and records replacement/expiry events', async () => {
    const { newsletter, input, advance } = await fixture({ expiresInMs: 1_000, replacementStrategy: 'REPLACE_PREVIOUS' })
    const first = (await newsletter.createConfirmationToken(input))!
    const second = (await newsletter.createConfirmationToken(input))!
    expect(await newsletter.confirm({ token: first.token })).toEqual({ confirmed: false })
    expect((await newsletter.listEvents({ email })).some(e => e.type === 'CONFIRMATION_REPLACED')).toBe(true)
    advance(1_000)
    expect(await newsletter.getConfirmationState(input)).toMatchObject({ canCreate: true, activeTokenExpiresAt: null })
    expect(await newsletter.confirm({ token: second.token })).toEqual({ confirmed: false })
    await newsletter.createConfirmationToken(input)
    expect((await newsletter.listEvents({ email })).some(e => e.type === 'CONFIRMATION_EXPIRED')).toBe(true)
  })

  it('retains usable tokens up to the configured bound and reports the newest expiry', async () => {
    const { newsletter, input, storage, advance } = await fixture({
      replacementStrategy: 'RETAIN_PREVIOUS_UNTIL_EXPIRY', maxActiveTokens: 2, expiresInMs: 5_000
    })
    const first = (await newsletter.createConfirmationToken(input))!
    advance(100)
    const second = (await newsletter.createConfirmationToken(input))!
    advance(100)
    const third = (await newsletter.createConfirmationToken(input))!
    expect(await newsletter.getConfirmationState(input)).toMatchObject({ activeTokenExpiresAt: third.expiresAt })
    expect(storage.confirmationTokenSnapshot().filter(t => t.revokedAt == null)).toHaveLength(2)
    expect(await newsletter.confirm({ token: first.token })).toEqual({ confirmed: false })
    expect(await newsletter.confirm({ token: second.token })).toEqual({ confirmed: true })
    expect(await newsletter.confirm({ token: third.token })).toEqual({ confirmed: false })
  })

  it('ignores old generations, consumed and revoked records when inspecting pending state', async () => {
    const { newsletter, input, subscription, storage } = await fixture()
    const old = (await newsletter.createConfirmationToken(input))!
    await storage.transaction(tx => tx.updateSubscription(subscription.id, { lifecycleGeneration: 2 }))
    expect(await newsletter.getConfirmationState(input)).toMatchObject({ activeTokenExpiresAt: null })
    expect(await newsletter.confirm({ token: old.token })).toEqual({ confirmed: false })
    const current = (await newsletter.createConfirmationToken(input))!
    expect(storage.confirmationTokenSnapshot().at(-1)!.lifecycleGeneration).toBe(2)
    await storage.transaction(async tx => {
      await tx.confirmationTokens.consume({ digest: await sha256Digest(current.token), now })
    })
    expect(await newsletter.getConfirmationState(input)).toMatchObject({ activeTokenExpiresAt: null })
    await newsletter.createConfirmationToken(input)
    await storage.transaction(tx => tx.confirmationTokens.revokeBySubscription({
      subscriptionId: subscription.id, lifecycleGeneration: 2, now
    }))
    expect(await newsletter.getConfirmationState(input)).toMatchObject({ activeTokenExpiresAt: null })
  })

  it('serializes concurrent creation across services and honors replacement', async () => {
    const { newsletter, options, input, storage } = await fixture({ replacementStrategy: 'REPLACE_PREVIOUS' })
    const other = betterNewsletter(options)
    const results = await Promise.all(Array.from({ length: 10 }, (_, index) =>
      (index % 2 ? newsletter : other).createConfirmationToken(input)
    ))
    expect(results.every(Boolean)).toBe(true)
    expect(new Set(results.map(r => r!.token)).size).toBe(10)
    expect(storage.confirmationTokenSnapshot().filter(t => t.revokedAt == null)).toHaveLength(1)
    expect((await newsletter.listEvents({ email })).filter(e => e.type === 'CONFIRMATION_TOKEN_CREATED')).toHaveLength(10)
    const confirmed = await Promise.all(results.map(r => newsletter.confirm({ token: r!.token })))
    expect(confirmed.filter(r => r.confirmed)).toHaveLength(1)
  })

  it('rechecks eligibility after lookup when suppression races creation', async () => {
    const { newsletter, storage, options, input } = await fixture()
    let transactions = 0
    const raced: NewsletterStorage = {
      async transaction(operation) {
        if (++transactions === 2) await newsletter.suppressContact({ email, reason: 'race' })
        return storage.transaction(operation)
      }
    }
    expect(await betterNewsletter({ ...options, storage: raced }).createConfirmationToken(input)).toBeNull()
    expect(storage.confirmationTokenSnapshot()).toHaveLength(0)
  })

  it('rolls back tokens and events together and retries storage conflicts', async () => {
    const { newsletter, storage, options, input } = await fixture()
    const before = await newsletter.listEvents({ email })
    let failed = false
    const conflicting: NewsletterStorage = {
      transaction: operation => storage.transaction(async tx => operation({
        ...tx,
        async appendEvent(event) {
          await tx.appendEvent(event)
          if (event.type === 'CONFIRMATION_TOKEN_CREATED' && !failed) {
            failed = true
            throw new StorageConflictError('Retry trusted creation')
          }
        }
      }))
    }
    const result = await betterNewsletter({ ...options, storage: conflicting }).createConfirmationToken({
      ...input, eventMetadata: { actorId: 'admin-retry' }
    })
    expect(failed).toBe(true)
    expect(storage.confirmationTokenSnapshot()).toHaveLength(1)
    expect(storage.confirmationTokenSnapshot()[0]!.digest).toBe(await sha256Digest(result!.token))
    expect(await newsletter.listEvents({ email })).toHaveLength(before.length + 1)
    expect((await newsletter.listEvents({ email })).at(-1)!.metadata.actorId).toBe('admin-retry')
  })
})
