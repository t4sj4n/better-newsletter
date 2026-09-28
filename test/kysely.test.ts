import { readFileSync } from 'node:fs'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CONFIRMATION_REPLACEMENT_STRATEGIES,
  CONTACT_STATUSES,
  NEWSLETTER_ERROR_CODES,
  NEWSLETTER_EVENT_TYPES,
  SUBSCRIPTION_STATUSES,
  createNewsletter,
  createHmacRateLimitKeyProvider,
  createSecureCapabilities,
  sha256Digest,
  type ConfirmationMailInput,
  type NewsletterConfig,
  type NewsletterMailer
} from '../src/index.js'
import {
  kyselyRateLimiter,
  kyselyStorage,
  listEligibleSubscriptions
} from '../src/kysely.js'

const databaseUrl = process.env.DATABASE_URL
const secret = '0123456789abcdef0123456789abcdef'
const email = 'person@example.com'
const consent = (version = 'v1') => ({
  granted: true,
  version,
  source: 'landing-page',
  locale: 'en'
} as const)

function gate() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}

describe.skipIf(!databaseUrl)('PostgreSQL Kysely integration', () => {
  const schema = `newsletter_test_${crypto.randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseUrl, max: 2 })
  const pool = new Pool({
    connectionString: databaseUrl,
    options: `-c search_path=${schema}`,
    max: 20
  })
  const db = new Kysely<Record<string, never>>({
    dialect: new PostgresDialect({ pool })
  })
  const tasks = new Set<Promise<void>>()

  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA "${schema}"`)
    const migration = readFileSync(
      new URL('../migrations/001_newsletter.sql', import.meta.url),
      'utf8'
    )
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(migration)
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  })

  beforeEach(async () => {
    await pool.query(
      'TRUNCATE newsletter_contacts, newsletter_rate_limits RESTART IDENTITY CASCADE'
    )
  })

  afterEach(async () => {
    while (tasks.size > 0) await Promise.all([...tasks])
  })

  afterAll(async () => {
    await db.destroy()
    try {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
    } finally {
      await admin.end()
    }
  })

  function setup() {
    let nowMs = Date.parse('2026-09-28T08:00:00.000Z')
    const clock = { now: () => new Date(nowMs) }
    const messages: ConfirmationMailInput[] = []
    let deliver: NewsletterMailer['sendConfirmation'] = async () => ({ accepted: true })
    const mailer: NewsletterMailer = {
      async sendConfirmation(input) {
        messages.push(input)
        return deliver(input)
      }
    }
    const makeService = (overrides: Partial<NewsletterConfig> = {}) =>
      createNewsletter({
        storage: kyselyStorage(db),
        capabilities: createSecureCapabilities({ hmacSecret: secret }),
        mailer,
        clock,
        transactionMaxAttempts: 20,
        runBackground(task) {
          tasks.add(task)
          void task.then(() => tasks.delete(task))
        },
        ...overrides
      })
    const service = makeService()
    return {
      service,
      makeService,
      messages,
      setDelivery: (next: NewsletterMailer['sendConfirmation']) => { deliver = next },
      advance: (ms: number) => { nowMs += ms },
      clock,
      async settle() {
        while (tasks.size > 0) await Promise.all([...tasks])
      }
    }
  }

  it('applies the migration and enforces normalized contact and per-audience uniqueness', async () => {
    const { service, settle } = setup()
    await service.subscribe({
      email: ' Person@Example.COM ',
      consent: consent(),
      subject: { namespace: 'app', id: 'customer-123' },
      metadata: { tier: 'pro' }
    })
    await settle()

    const contact = await service.getContact({ email })
    const subscription = await service.getSubscription({ email })
    expect(contact).toMatchObject({
      email,
      status: CONTACT_STATUSES.ENABLED,
      subject: { namespace: 'app', id: 'customer-123' },
      metadata: { tier: 'pro' }
    })
    expect(subscription).toMatchObject({
      audienceKey: 'default',
      status: SUBSCRIPTION_STATUSES.PENDING_CONFIRMATION,
      consent: { version: 'v1', source: 'landing-page', locale: 'en' }
    })
    expect(subscription?.consent.consentedAt).toBeInstanceOf(Date)
    await expect(pool.query(
      `INSERT INTO newsletter_contacts
        (id, email, status, created_at, updated_at)
       SELECT 'duplicate', email, status, created_at, updated_at
       FROM newsletter_contacts WHERE id = $1`,
      [contact!.id]
    )).rejects.toMatchObject({ code: '23505' })
    await expect(pool.query(
      `INSERT INTO newsletter_subscriptions
        (id, contact_id, audience_key, status, consent_version, consented_at,
         created_at, updated_at)
       SELECT 'duplicate', contact_id, audience_key, status, consent_version,
              consented_at, created_at, updated_at
       FROM newsletter_subscriptions WHERE id = $1`,
      [subscription!.id]
    )).rejects.toMatchObject({ code: '23505' })
  })

  it('stores evidence and subject changes without leaking email, subject ID or tokens into events', async () => {
    const { service, messages, settle } = setup()
    await service.subscribe({
      email,
      consent: consent(),
      subject: { namespace: 'crm', id: 'private-subject' }
    })
    await settle()
    await expect(service.linkSubject({
      email,
      subject: { namespace: 'crm', id: 'other' }
    })).rejects.toMatchObject({ code: NEWSLETTER_ERROR_CODES.SUBJECT_CONFLICT })
    await service.linkSubject({
      email,
      subject: { namespace: 'crm', id: 'other' },
      replace: true
    })

    const events = await service.listEvents({ email })
    expect(events.map(event => event.type)).toEqual([
      NEWSLETTER_EVENT_TYPES.SIGNED_UP,
      NEWSLETTER_EVENT_TYPES.CONFIRMATION_REQUESTED,
      NEWSLETTER_EVENT_TYPES.CONFIRMATION_SENT,
      NEWSLETTER_EVENT_TYPES.SUBJECT_LINKED
    ])
    const rawEvents = await pool.query<{ metadata: unknown; event_type: string }>(
      'SELECT event_type, metadata FROM newsletter_events ORDER BY sequence'
    )
    expect(rawEvents.rows.map(row => row.event_type)).toEqual(events.map(event => event.type))
    expect(JSON.stringify(rawEvents.rows)).not.toContain(email)
    expect(JSON.stringify(rawEvents.rows)).not.toContain('private-subject')
    expect(JSON.stringify(rawEvents.rows)).not.toContain('other')
    expect(JSON.stringify(rawEvents.rows)).not.toContain(messages[0]!.token)
    expect(events[0]?.metadata).toMatchObject({
      consentVersion: 'v1',
      audienceKey: 'default'
    })
  })

  it('persists only token digests and atomically consumes across service instances', async () => {
    const { service, makeService, messages, settle } = setup()
    await service.subscribe({ email, consent: consent() })
    await settle()
    const token = messages[0]!.token
    const digest = await sha256Digest(token)
    const tokens = await pool.query<{ digest: string; consumed_at: Date | null }>(
      'SELECT digest, consumed_at FROM newsletter_tokens'
    )
    expect(tokens.rows).toEqual([{ digest, consumed_at: null }])
    expect(JSON.stringify(tokens.rows)).not.toContain(token)

    const other = makeService()
    await expect(other.confirm({ token })).resolves.toEqual({ confirmed: true })
    await expect(service.confirm({ token })).resolves.toEqual({ confirmed: false })
    expect((await service.getSubscription({ email }))?.status).toBe(SUBSCRIPTION_STATUSES.ACTIVE)
    const persisted = await pool.query<{ consumed_at: Date | null }>(
      'SELECT consumed_at FROM newsletter_tokens WHERE digest = $1',
      [digest]
    )
    expect(persisted.rows[0]?.consumed_at).toBeInstanceOf(Date)
  })

  it('serializes confirm races with unsubscribe and suppression without leaving eligible recipients', async () => {
    for (const action of ['unsubscribe', 'suppress'] as const) {
      const address = `${action}@example.com`
      const { service, makeService, messages, settle } = setup()
      const other = makeService()
      await service.subscribe({ email: address, consent: consent() })
      await settle()
      const token = messages[0]!.token
      const capability = (await service.createUnsubscribeCapability({ email: address }))!
      const [confirmation, transition] = await Promise.all([
        service.confirm({ token }),
        action === 'unsubscribe'
          ? other.unsubscribe({ capability })
          : other.suppressContact({ email: address, reason: 'BOUNCE' })
      ])
      expect(typeof confirmation.confirmed).toBe('boolean')
      if (action === 'unsubscribe') {
        expect(transition).toEqual({ unsubscribed: true })
        expect((await service.getSubscription({ email: address }))?.status)
          .toBe(SUBSCRIPTION_STATUSES.UNSUBSCRIBED)
      } else {
        expect(transition).toMatchObject({ status: CONTACT_STATUSES.SUPPRESSED })
      }
      expect((await listEligibleSubscriptions(db, 'default')).some(row =>
        row.contact.email === address
      )).toBe(false)
      await expect(other.confirm({ token })).resolves.toEqual({ confirmed: false })
      const persisted = await pool.query<{
        consumed_at: Date | null; revoked_at: Date | null
      }>(
        'SELECT consumed_at, revoked_at FROM newsletter_tokens WHERE digest = $1',
        [await sha256Digest(token)]
      )
      expect(persisted.rows).toHaveLength(1)
      expect(persisted.rows[0]?.consumed_at != null || persisted.rows[0]?.revoked_at != null)
        .toBe(true)
    }
  })

  it('rolls back token consumption together with lifecycle and events', async () => {
    const { service, messages, settle, clock } = setup()
    await service.subscribe({ email, consent: consent() })
    await settle()
    const digest = await sha256Digest(messages[0]!.token)
    const before = await pool.query<{ count: string }>(
      'SELECT count(*) FROM newsletter_events'
    )
    await expect(kyselyStorage(db).transaction(async trx => {
      expect(await trx.confirmationTokens.consume({ digest, now: clock.now() })).not.toBeNull()
      const contact = await trx.getContactByEmail(email)
      await trx.updateContact(contact!.id, { status: CONTACT_STATUSES.SUPPRESSED })
      await trx.appendEvent({
        id: crypto.randomUUID(),
        contactId: contact!.id,
        type: NEWSLETTER_EVENT_TYPES.SUPPRESSED,
        occurredAt: clock.now(),
        metadata: {}
      })
      throw new Error('rollback the whole transaction')
    })).rejects.toThrow('rollback the whole transaction')
    expect((await pool.query<{ consumed_at: Date | null }>(
      'SELECT consumed_at FROM newsletter_tokens WHERE digest = $1', [digest]
    )).rows[0]?.consumed_at).toBeNull()
    expect((await pool.query<{ count: string }>(
      'SELECT count(*) FROM newsletter_events'
    )).rows[0]?.count).toBe(before.rows[0]?.count)
    expect((await service.getContact({ email }))?.status).toBe(CONTACT_STATUSES.ENABLED)
    await expect(service.confirm({ token: messages[0]!.token }))
      .resolves.toEqual({ confirmed: true })
  })

  it('fences stale confirmations and unsubscribe links after a new consent generation', async () => {
    const { service, makeService, messages, settle, advance } = setup()
    const other = makeService()
    await service.subscribe({ email, consent: consent('v1') })
    await settle()
    const staleToken = messages[0]!.token
    await other.confirm({ token: staleToken })
    const staleLink = (await service.createUnsubscribeCapability({ email }))!
    const staleAll = (await service.createUnsubscribeCapability({ email, all: true }))!
    await service.unsubscribe({ capability: staleLink })

    advance(1_000)
    await other.subscribe({ email, consent: consent('v2') })
    await settle()
    expect((await service.getSubscription({ email }))?.lifecycleGeneration).toBe(2)
    expect((await service.getContact({ email }))?.capabilityGeneration).toBe(2)
    expect((await service.getSubscription({ email }))?.consent.version).toBe('v2')
    await expect(service.confirm({ token: staleToken })).resolves.toEqual({ confirmed: false })
    await expect(other.unsubscribe({ capability: staleLink }))
      .resolves.toEqual({ unsubscribed: false })
    await expect(other.unsubscribeAll({ capability: staleAll }))
      .resolves.toEqual({ unsubscribed: false })
    await expect(other.confirm({ token: messages[1]!.token }))
      .resolves.toEqual({ confirmed: true })
  })

  it('makes parallel first signups idempotent across independent instances', async () => {
    const { service, makeService, messages, settle } = setup()
    const other = makeService()
    const requests = Array.from({ length: 6 }, (_, index) =>
      (index % 2 === 0 ? service : other).subscribe({ email, consent: consent() })
    )
    await expect(Promise.all(requests)).resolves.toEqual(
      Array.from({ length: 6 }, () => ({ accepted: true }))
    )
    await settle()
    expect((await pool.query<{ count: string }>(
      'SELECT count(*) FROM newsletter_contacts'
    )).rows[0]?.count).toBe('1')
    expect((await pool.query<{ count: string }>(
      'SELECT count(*) FROM newsletter_subscriptions'
    )).rows[0]?.count).toBe('1')
    expect(messages).toHaveLength(1)
  })

  it('serializes simultaneous new audiences and invalidates the earlier unsubscribe-all link', async () => {
    const { service, makeService, settle } = setup()
    await service.subscribe({ email, consent: consent() })
    await settle()
    const oldAll = (await service.createUnsubscribeCapability({ email, all: true }))!
    const other = makeService()
    const audiences = ['product', 'engineering', 'events', 'offers']
    await expect(Promise.all(audiences.map((audience, index) =>
      (index % 2 === 0 ? service : other).subscribe({
        email,
        audience,
        consent: consent(audience)
      })
    ))).resolves.toEqual(audiences.map(() => ({ accepted: true })))
    await settle()

    expect((await service.getContact({ email }))?.capabilityGeneration)
      .toBe(audiences.length + 1)
    expect((await service.listSubscriptions({ email })).map(row => row.audienceKey).sort())
      .toEqual(['default', ...audiences].sort())
    expect((await pool.query<{ count: string }>(
      'SELECT count(*) FROM newsletter_subscriptions'
    )).rows[0]?.count).toBe('5')
    await expect(other.unsubscribeAll({ capability: oldAll }))
      .resolves.toEqual({ unsubscribed: false })
    const currentAll = (await other.createUnsubscribeCapability({ email, all: true }))!
    await expect(service.unsubscribeAll({ capability: currentAll }))
      .resolves.toEqual({ unsubscribed: true })
    expect((await other.listSubscriptions({ email })).every(row =>
      row.status === SUBSCRIPTION_STATUSES.UNSUBSCRIBED
    )).toBe(true)
  })

  it('rejects an in-flight unsubscribe-all resolved before a new audience starts', async () => {
    const { service, makeService, settle } = setup()
    await service.subscribe({ email, consent: consent() })
    await settle()
    const capability = (await service.createUnsubscribeCapability({ email, all: true }))!
    const other = makeService()
    const resolved = gate()
    const resume = gate()
    const original = other.capabilities.resolveUnsubscribeCapability
    vi.spyOn(other.capabilities, 'resolveUnsubscribeCapability')
      .mockImplementationOnce(async value => {
        const target = await original(value)
        resolved.release()
        await resume.promise
        return target
      })
    const stale = other.unsubscribeAll({ capability })
    try {
      await resolved.promise
      await service.subscribe({ email, audience: 'product', consent: consent() })
      await settle()
    } finally {
      resume.release()
    }
    await expect(stale).resolves.toEqual({ unsubscribed: false })
    expect((await service.listSubscriptions({ email })).map(row => row.status))
      .toEqual([
        SUBSCRIPTION_STATUSES.PENDING_CONFIRMATION,
        SUBSCRIPTION_STATUSES.PENDING_CONFIRMATION
      ])
  })

  it('leases confirmation delivery across instances instead of sending twice', async () => {
    const { service, makeService, messages, settle, setDelivery } = setup()
    await service.subscribe({ email, consent: consent() })
    await settle()
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    setDelivery(async () => {
      entered()
      await held
      return { accepted: true }
    })
    const other = makeService()
    try {
      await service.resendConfirmation({ email })
      await started
      await other.resendConfirmation({ email })
      expect(messages).toHaveLength(2)
    } finally {
      release()
    }
    await settle()
    const events = await service.listEvents({ email })
    expect(events.filter(event => event.type === NEWSLETTER_EVENT_TYPES.CONFIRMATION_SENT))
      .toHaveLength(2)
  })

  it('reclaims an expired lease and fences an earlier provider result as stale', async () => {
    const { makeService, messages, advance, setDelivery, settle } = setup()
    const first = makeService({ confirmation: { deliveryLeaseMs: 1_000 } })
    const second = makeService({ confirmation: { deliveryLeaseMs: 1_000 } })
    const oldSend = gate()
    const newSend = gate()
    setDelivery(async input => {
      await (input.attemptId === messages[0]?.attemptId
        ? oldSend.promise
        : newSend.promise)
      return { accepted: true }
    })

    try {
      await first.subscribe({ email, consent: consent() })
      await vi.waitFor(() => expect(messages).toHaveLength(1))
      const previous = (await first.getSubscription({ email }))!.confirmationDelivery!
      expect(previous.attemptId).toBe(messages[0]!.attemptId)
      advance(999)
      await second.resendConfirmation({ email })
      await vi.waitFor(async () => {
        const events = await second.listEvents({ email })
        expect(events.filter(event =>
          event.type === NEWSLETTER_EVENT_TYPES.CONFIRMATION_REQUESTED
        )).toHaveLength(1)
      })
      expect(messages).toHaveLength(1)

      advance(1)
      await second.resendConfirmation({ email })
      await vi.waitFor(() => expect(messages).toHaveLength(2))
      const current = (await second.getSubscription({ email }))!.confirmationDelivery!
      expect(current.id).toBe(previous.id)
      expect(current.attemptId).not.toBe(previous.attemptId)

      oldSend.release()
      await vi.waitFor(async () => {
        const events = await first.listEvents({ email })
        expect(events.filter(event =>
          event.type === NEWSLETTER_EVENT_TYPES.CONFIRMATION_STALE_RESULT
        )).toHaveLength(1)
      })
      expect(await second.getSubscription({ email })).toMatchObject({
        confirmationDelivery: current,
        confirmationSentAt: null
      })
      expect((await first.listEvents({ email })).filter(event =>
        event.type === NEWSLETTER_EVENT_TYPES.CONFIRMATION_STALE_RESULT
      )[0]?.metadata).toMatchObject({
        attemptId: previous.attemptId,
        authoritative: false,
        outcome: 'ACCEPTED'
      })
    } finally {
      oldSend.release()
      newSend.release()
    }
    await settle()
    const events = await second.listEvents({ email })
    expect(events.filter(event => event.type === NEWSLETTER_EVENT_TYPES.CONFIRMATION_SENT))
      .toHaveLength(1)
    expect((await second.getSubscription({ email }))?.confirmationDelivery).toBeNull()
    await expect(first.confirm({ token: messages[1]!.token }))
      .resolves.toEqual({ confirmed: true })
  })

  it.each([
    [CONFIRMATION_REPLACEMENT_STRATEGIES.REPLACE_PREVIOUS, 1],
    [CONFIRMATION_REPLACEMENT_STRATEGIES.RETAIN_PREVIOUS_UNTIL_EXPIRY, 2]
  ] as const)(
    'bounds %s tokens and scopes retention to the current lifecycle generation',
    async (replacementStrategy, activeCount) => {
      const { makeService, messages, settle, advance, clock } = setup()
      const service = makeService({
        confirmation: { replacementStrategy, maxActiveTokens: 2 }
      })
      await service.subscribe({ email, consent: consent() })
      await settle()
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await service.resendConfirmation({ email })
        await settle()
      }
      expect(messages).toHaveLength(3)
      const firstGeneration = await pool.query<{
        digest: string; lifecycle_generation: string; revoked_at: Date | null
      }>('SELECT digest, lifecycle_generation, revoked_at FROM newsletter_tokens ORDER BY id')
      expect(firstGeneration.rows.map(row => row.digest))
        .toEqual(await Promise.all(messages.map(message => sha256Digest(message.token))))
      expect(firstGeneration.rows.filter(row => row.revoked_at == null)).toHaveLength(activeCount)
      expect(firstGeneration.rows.every(row => row.lifecycle_generation === '1')).toBe(true)
      await expect(service.confirm({ token: messages[0]!.token }))
        .resolves.toEqual({ confirmed: false })

      const link = (await service.createUnsubscribeCapability({ email }))!
      await service.unsubscribe({ capability: link })
      advance(1)
      await service.subscribe({ email, consent: consent('new-cycle') })
      await settle()
      expect((await service.getSubscription({ email }))?.lifecycleGeneration).toBe(2)
      const all = await pool.query<{
        digest: string; lifecycle_generation: string; revoked_at: Date | null
      }>('SELECT digest, lifecycle_generation, revoked_at FROM newsletter_tokens ORDER BY id')
      expect(all.rows).toHaveLength(4)
      expect(all.rows.slice(0, 3).every(row =>
        row.lifecycle_generation === '1' && row.revoked_at instanceof Date
      )).toBe(true)
      expect(all.rows[3]).toMatchObject({
        digest: await sha256Digest(messages[3]!.token),
        lifecycle_generation: '2',
        revoked_at: null
      })
      const legacyDigest = await sha256Digest(`stale-${replacementStrategy}`)
      const contact = (await service.getContact({ email }))!
      const subscription = (await service.getSubscription({ email }))!
      await kyselyStorage(db).transaction(trx => trx.confirmationTokens.replace({
        record: {
          digest: legacyDigest,
          purpose: 'CONFIRMATION',
          contactId: contact.id,
          subscriptionId: subscription.id,
          lifecycleGeneration: 1,
          createdAt: clock.now(),
          expiresAt: new Date(clock.now().getTime() + 60_000)
        },
        strategy: replacementStrategy,
        maxActiveTokens: 2,
        now: clock.now()
      }))
      await service.resendConfirmation({ email })
      await settle()
      expect((await pool.query<{ revoked_at: Date | null }>(
        'SELECT revoked_at FROM newsletter_tokens WHERE digest = $1', [legacyDigest]
      )).rows[0]?.revoked_at).toBeNull()
      const secondGeneration = await pool.query<{ revoked_at: Date | null }>(
        'SELECT revoked_at FROM newsletter_tokens WHERE lifecycle_generation = 2'
      )
      expect(secondGeneration.rows.filter(row => row.revoked_at == null))
        .toHaveLength(activeCount)
      await expect(service.confirm({ token: messages[2]!.token }))
        .resolves.toEqual({ confirmed: false })
      await expect(service.confirm({ token: messages.at(-1)!.token }))
        .resolves.toEqual({ confirmed: true })
    }
  )

  it('matches core eligibility for pending, active, unsubscribed and suppressed contacts', async () => {
    const { service, messages, settle } = setup()
    await service.subscribe({ email, consent: consent() })
    await settle()
    expect(await listEligibleSubscriptions(db, 'default')).toHaveLength(0)
    await service.confirm({ token: messages[0]!.token })
    const active = await listEligibleSubscriptions(db, 'default')
    expect(active.map(row => row.contact.email)).toEqual([email])
    expect(active[0]?.subscription.consent.consentedAt).toBeInstanceOf(Date)
    expect(active[0]?.contact.metadata).toEqual({})
    expect(service.getDeliveryEligibility(active[0]!.contact, active[0]!.subscription))
      .toEqual({ eligible: true })

    await service.importSubscription({
      email: 'second@example.com',
      status: SUBSCRIPTION_STATUSES.ACTIVE,
      consent: { version: 'imported', consentedAt: new Date('2026-01-01T00:00:00Z') },
      confirmedAt: new Date('2026-01-02T00:00:00Z')
    })
    expect(await listEligibleSubscriptions(db, 'default')).toHaveLength(2)
    await service.suppressContact({ email, reason: 'BOUNCE' })
    expect((await service.getSubscription({ email }))?.status).toBe(SUBSCRIPTION_STATUSES.ACTIVE)
    expect((await listEligibleSubscriptions(db, 'default')).map(row => row.contact.email))
      .toEqual(['second@example.com'])
    await service.unsuppressContact({ email })
    expect(await listEligibleSubscriptions(db, 'default')).toHaveLength(2)
    const capability = (await service.createUnsubscribeCapability({ email }))!
    await service.unsubscribe({ capability })
    expect((await listEligibleSubscriptions(db, 'default')).map(row => row.contact.email))
      .toEqual(['second@example.com'])
    expect(await listEligibleSubscriptions(db, 'other')).toEqual([])
  })

  it('revokes pending tokens on suppression and unsubscribes all audiences independently', async () => {
    const { service, messages, settle } = setup()
    await service.subscribe({ email, consent: consent() })
    await settle()
    await service.confirm({ token: messages[0]!.token })
    await service.subscribe({ email, audience: 'product', consent: consent('v2') })
    await settle()
    const pendingToken = messages[1]!.token
    const all = (await service.createUnsubscribeCapability({ email, all: true }))!
    await service.suppressContact({ email, reason: 'BOUNCE' })
    await expect(service.confirm({ token: pendingToken })).resolves.toEqual({ confirmed: false })
    expect((await pool.query<{ revoked_at: Date | null }>(
      'SELECT revoked_at FROM newsletter_tokens WHERE digest = $1',
      [await sha256Digest(pendingToken)]
    )).rows[0]?.revoked_at).toBeInstanceOf(Date)
    await service.unsubscribeAll({ capability: all })
    expect((await service.listSubscriptions({ email })).map(row => row.status))
      .toEqual([SUBSCRIPTION_STATUSES.UNSUBSCRIBED, SUBSCRIPTION_STATUSES.UNSUBSCRIBED])
    await service.unsuppressContact({ email })
    expect((await service.getContact({ email }))?.status).toBe(CONTACT_STATUSES.ENABLED)
    expect(await listEligibleSubscriptions(db, 'default')).toEqual([])
  })

  it('atomically rate-limits by hashed key and cleans expired buckets', async () => {
    const { clock, advance } = setup()
    const provider = createHmacRateLimitKeyProvider({ secret })
    const key = await provider.createKey({
      action: 'subscribe',
      email,
      audienceKey: 'default'
    })
    const first = kyselyRateLimiter(db, clock)
    const second = kyselyRateLimiter(db, clock)
    expect(key).toMatch(/^[a-f0-9]{64}$/u)
    await expect(first.consume({
      key: email, action: 'subscribe', limit: 5, windowMs: 60_000
    })).rejects.toThrow('HMAC digest')
    const attempts = await Promise.all(Array.from({ length: 20 }, (_, index) =>
      (index % 2 === 0 ? first : second).consume({
        key, action: 'subscribe', limit: 5, windowMs: 60_000
      })
    ))
    expect(attempts.filter(result => result.allowed)).toHaveLength(5)
    expect(attempts.filter(result => !result.allowed)).toHaveLength(15)
    expect(await first.consume({
      key, action: 'resend-confirmation', limit: 1, windowMs: 60_000
    })).toEqual({ allowed: true })
    const rows = await pool.query<{ key_hash: string; attempt_count: number }>(
      'SELECT key_hash, attempt_count FROM newsletter_rate_limits ORDER BY action'
    )
    expect(rows.rows.map(row => row.attempt_count).sort((a, b) => a - b)).toEqual([1, 20])
    expect(JSON.stringify(rows.rows)).not.toContain(email)
    expect(rows.rows.every(row => row.key_hash === key)).toBe(true)
    advance(60_000)
    await expect(first.cleanup()).resolves.toBe(2)
    await expect(second.consume({
      key, action: 'subscribe', limit: 5, windowMs: 60_000
    })).resolves.toEqual({ allowed: true })
  })

  it('integrates SQL rate limits into signup before writing the contact', async () => {
    const { makeService, clock } = setup()
    const service = makeService({
      rateLimiter: kyselyRateLimiter(db, clock),
      rateLimitKeyProvider: createHmacRateLimitKeyProvider({ secret }),
      rateLimits: { subscribe: { limit: 1, windowMs: 60_000 } }
    })
    await service.subscribe({ email, consent: consent() })
    await expect(service.subscribe({ email, consent: consent() }))
      .rejects.toMatchObject({ code: NEWSLETTER_ERROR_CODES.RATE_LIMITED })
    expect((await pool.query<{ count: string }>(
      'SELECT count(*) FROM newsletter_contacts'
    )).rows[0]?.count).toBe('1')
  })

  it('cleans old tokens and cascades erasure to subscriptions, tokens and events', async () => {
    const { service, messages, settle, advance } = setup()
    await service.subscribe({ email, consent: consent() })
    await settle()
    await service.confirm({ token: messages[0]!.token })
    advance(8 * 24 * 60 * 60 * 1_000)
    await expect(service.cleanupConfirmationTokens({ retentionMs: 0 })).resolves.toBe(1)
    await expect(service.cleanupConfirmationTokens({ retentionMs: 0 })).resolves.toBe(0)

    await service.subscribe({
      email: 'erase@example.com',
      consent: consent(),
      metadata: { private: 'redact-me' }
    })
    await settle()
    const toErase = await service.getContact({ email: 'erase@example.com' })
    await pool.query('DELETE FROM newsletter_contacts WHERE id = $1', [toErase!.id])
    for (const table of [
      'newsletter_subscriptions', 'newsletter_tokens', 'newsletter_events'
    ]) {
      const result = await pool.query<{ count: string }>(
        `SELECT count(*) FROM ${table} WHERE contact_id = $1`, [toErase!.id]
      )
      expect(result.rows[0]?.count).toBe('0')
    }
    expect(await service.getContact({ email: 'erase@example.com' })).toBeNull()
    expect(await service.getContact({ email })).not.toBeNull()
  })
})
