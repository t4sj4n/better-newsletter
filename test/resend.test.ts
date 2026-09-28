import { Resend } from 'resend'
import { describe, expect, it, vi } from 'vitest'
import {
  CONTACT_STATUSES,
  MAIL_DELIVERY_FAILURES,
  MAIL_DELIVERY_REASONS,
  NEWSLETTER_EVENT_TYPES,
  SUBSCRIPTION_STATUSES,
  createNewsletter,
  createSecureCapabilities,
  type ConfirmationMailInput,
  type MailDeliveryReasonCode
} from '../src/index.js'
import { memoryStorage } from '../src/memory.js'
import { resendMailer, type ResendEmailClient } from '../src/resend.js'

const secret = '0123456789abcdef0123456789abcdef'
const now = new Date('2026-09-28T08:00:00.000Z')

function confirmationInput(): ConfirmationMailInput {
  return {
    contact: {
      id: 'contact-1',
      capabilityGeneration: 1,
      email: 'person@example.com',
      status: CONTACT_STATUSES.ENABLED,
      subject: null,
      createdAt: now,
      updatedAt: now
    },
    subscription: {
      id: 'subscription-1',
      lifecycleGeneration: 2,
      contactId: 'contact-1',
      audienceKey: 'product',
      status: SUBSCRIPTION_STATUSES.PENDING_CONFIRMATION,
      consent: {
        version: 'v2',
        source: 'signup',
        locale: 'en',
        consentedAt: now
      },
      confirmationDelivery: {
        id: 'work-1',
        attemptId: 'attempt-1',
        leaseExpiresAt: new Date(now.getTime() + 60_000)
      },
      createdAt: now,
      updatedAt: now
    },
    token: 'raw-confirmation-token',
    expiresAt: new Date(now.getTime() + 3_600_000),
    deliveryId: 'work-1',
    attemptId: 'attempt-1',
    audienceKey: 'product',
    lifecycleGeneration: 2
  }
}

type SendResponse = Awaited<ReturnType<ResendEmailClient['emails']['send']>>
type ResendError = NonNullable<SendResponse['error']>

function errorResponse(name: ResendError['name'], statusCode: number | null): SendResponse {
  return {
    data: null,
    error: { name, statusCode, message: 'raw provider error: re_secret raw-confirmation-token' },
    headers: null
  }
}

function setup() {
  const send = vi.fn<ResendEmailClient['emails']['send']>()
  const client = { emails: { send } }
  const renderConfirmation = vi.fn((input: ConfirmationMailInput) => ({
    subject: `Confirm ${input.audienceKey}`,
    html: `<a href="https://app.example/confirm?token=${encodeURIComponent(input.token)}">Confirm</a>`,
    text: `Confirm ${input.audienceKey}: https://app.example/confirm?token=${encodeURIComponent(input.token)}`
  }))
  const mailer = resendMailer({
    client,
    from: 'Newsletter <news@example.com>',
    replyTo: 'support@example.com',
    renderConfirmation
  })
  return { client, send, renderConfirmation, mailer }
}

describe('Resend confirmation mailer', () => {
  it('accepts an injected SDK client without sending a network request', () => {
    const sdk: ResendEmailClient = new Resend('re_test_key')
    expect(resendMailer({
      client: sdk,
      from: 'news@example.com',
      renderConfirmation: () => ({ subject: 'Confirm', text: 'Confirm' })
    })).toHaveProperty('sendConfirmation', expect.any(Function))
  })

  it('renders host-owned URLs and sends HTML and text with correlation-based idempotency', async () => {
    const { send, renderConfirmation, mailer } = setup()
    send.mockResolvedValue({ data: { id: 'provider-message-1' }, error: null, headers: null })
    const input = confirmationInput()

    await expect(mailer.sendConfirmation(input)).resolves.toEqual({
      accepted: true,
      providerMessageId: 'provider-message-1'
    })
    expect(renderConfirmation).toHaveBeenCalledWith(input)
    expect(send).toHaveBeenCalledWith({
      from: 'Newsletter <news@example.com>',
      to: 'person@example.com',
      replyTo: 'support@example.com',
      subject: 'Confirm product',
      html: expect.stringContaining('raw-confirmation-token'),
      text: expect.stringContaining('raw-confirmation-token')
    }, { idempotencyKey: expect.stringMatching(/^bn-confirmation\/[a-f0-9]{64}$/u) })

    await mailer.sendConfirmation(input)
    expect(send.mock.calls[1]?.[1]?.idempotencyKey)
      .toBe(send.mock.calls[0]?.[1]?.idempotencyKey)
    await mailer.sendConfirmation({
      ...input,
      attemptId: 'attempt-2',
      token: 'different-token'
    })
    expect(send.mock.calls[2]?.[1]?.idempotencyKey)
      .not.toBe(send.mock.calls[0]?.[1]?.idempotencyKey)
    expect(send.mock.calls[0]?.[1]?.idempotencyKey).not.toContain(input.token)
    expect(send.mock.calls[0]?.[1]?.idempotencyKey).not.toContain(input.contact.email)
  })

  it('supports a host text-only renderer without a default template', async () => {
    const send = vi.fn<ResendEmailClient['emails']['send']>()
      .mockResolvedValue({ data: { id: 'id-2' }, error: null, headers: null })
    const mailer = resendMailer({
      client: { emails: { send } },
      from: 'news@example.com',
      renderConfirmation: input => ({
        subject: `Confirm ${input.audienceKey}`,
        text: `Token ${input.token}`
      })
    })
    await expect(mailer.sendConfirmation(confirmationInput()))
      .resolves.toEqual({ accepted: true, providerMessageId: 'id-2' })
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      subject: 'Confirm product',
      text: 'Token raw-confirmation-token'
    })
    expect(send.mock.calls[0]?.[0]).not.toHaveProperty('html')
    expect(send.mock.calls[0]?.[0]).not.toHaveProperty('replyTo')
  })

  it('uses the supported HTTP send endpoint with no SDK or real network request', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ id: 'provider-message-3' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      }))
    const mailer = resendMailer({
      apiKey: 're_test_key',
      fetch: fetcher,
      from: 'news@example.com',
      replyTo: 'support@example.com',
      renderConfirmation: () => ({ subject: 'Confirm', html: '<p>Confirm</p>', text: 'Confirm' })
    })
    await expect(mailer.sendConfirmation(confirmationInput())).resolves.toEqual({
      accepted: true,
      providerMessageId: 'provider-message-3'
    })
    expect(fetcher).toHaveBeenCalledOnce()
    const [url, init] = fetcher.mock.calls[0]!
    expect(url).toBe('https://api.resend.com/emails')
    expect(init?.method).toBe('POST')
    const headers = new Headers(init?.headers)
    expect(headers.get('authorization')).toBe('Bearer re_test_key')
    expect(headers.get('idempotency-key')).toMatch(/^bn-confirmation\/[a-f0-9]{64}$/u)
    if (typeof init?.body !== 'string') throw new Error('Expected a JSON request body.')
    expect(JSON.parse(init.body)).toEqual({
      from: 'news@example.com',
      to: 'person@example.com',
      subject: 'Confirm',
      html: '<p>Confirm</p>',
      text: 'Confirm',
      reply_to: 'support@example.com'
    })
  })

  it('does not log or retain provider error bodies from the HTTP transport', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ name: 'service_unavailable', message: 're_secret raw-confirmation-token' }),
        { status: 503 }
      ))
      .mockResolvedValueOnce(new Response('re_secret raw-confirmation-token', { status: 422 }))
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ name: 'concurrent_idempotent_requests', message: 'raw-confirmation-token' }),
        { status: 409 }
      ))
      .mockRejectedValueOnce(Object.assign(new Error('re_secret raw-confirmation-token'), {
        name: 'TimeoutError'
      }))
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const mailer = resendMailer({
        apiKey: 're_test_key',
        fetch: fetcher,
        from: 'news@example.com',
        renderConfirmation: () => ({ subject: 'Confirm', text: 'Confirm' })
      })
      await expect(mailer.sendConfirmation(confirmationInput())).resolves.toEqual({
        accepted: false,
        failure: MAIL_DELIVERY_FAILURES.AMBIGUOUS,
        reason: MAIL_DELIVERY_REASONS.PROVIDER_UNAVAILABLE
      })
      await expect(mailer.sendConfirmation(confirmationInput())).resolves.toEqual({
        accepted: false,
        failure: MAIL_DELIVERY_FAILURES.PERMANENT,
        reason: MAIL_DELIVERY_REASONS.INVALID_REQUEST
      })
      await expect(mailer.sendConfirmation(confirmationInput())).resolves.toEqual({
        accepted: false,
        failure: MAIL_DELIVERY_FAILURES.AMBIGUOUS,
        reason: MAIL_DELIVERY_REASONS.UNKNOWN
      })
      await expect(mailer.sendConfirmation(confirmationInput())).resolves.toEqual({
        accepted: false,
        failure: MAIL_DELIVERY_FAILURES.AMBIGUOUS,
        reason: MAIL_DELIVERY_REASONS.TIMEOUT
      })
      expect(log).not.toHaveBeenCalled()
    } finally {
      log.mockRestore()
    }
  })

  it.each([
    ['invalid_api_key', 401, MAIL_DELIVERY_FAILURES.PERMANENT, MAIL_DELIVERY_REASONS.AUTH_FAILED],
    ['restricted_api_key', 403, MAIL_DELIVERY_FAILURES.PERMANENT, MAIL_DELIVERY_REASONS.AUTH_FAILED],
    ['suspended_api_key', 403, MAIL_DELIVERY_FAILURES.PERMANENT, MAIL_DELIVERY_REASONS.AUTH_FAILED],
    ['validation_error', 403, MAIL_DELIVERY_FAILURES.PERMANENT, MAIL_DELIVERY_REASONS.INVALID_REQUEST],
    ['not_found', 403, MAIL_DELIVERY_FAILURES.PERMANENT, MAIL_DELIVERY_REASONS.INVALID_REQUEST],
    ['validation_error', 422, MAIL_DELIVERY_FAILURES.PERMANENT, MAIL_DELIVERY_REASONS.INVALID_REQUEST],
    ['invalid_from_address', null, MAIL_DELIVERY_FAILURES.PERMANENT, MAIL_DELIVERY_REASONS.INVALID_REQUEST],
    ['invalid_idempotent_request', 409, MAIL_DELIVERY_FAILURES.PERMANENT, MAIL_DELIVERY_REASONS.INVALID_REQUEST],
    ['rate_limit_exceeded', 429, MAIL_DELIVERY_FAILURES.TEMPORARY, MAIL_DELIVERY_REASONS.RATE_LIMITED],
    ['daily_quota_exceeded', 429, MAIL_DELIVERY_FAILURES.TEMPORARY, MAIL_DELIVERY_REASONS.RATE_LIMITED],
    ['concurrent_idempotent_requests', 409, MAIL_DELIVERY_FAILURES.AMBIGUOUS, MAIL_DELIVERY_REASONS.UNKNOWN],
    ['application_error', 500, MAIL_DELIVERY_FAILURES.AMBIGUOUS, MAIL_DELIVERY_REASONS.PROVIDER_UNAVAILABLE],
    ['rate_limit_exceeded', 500, MAIL_DELIVERY_FAILURES.AMBIGUOUS, MAIL_DELIVERY_REASONS.PROVIDER_UNAVAILABLE],
    ['service_unavailable', 503, MAIL_DELIVERY_FAILURES.AMBIGUOUS, MAIL_DELIVERY_REASONS.PROVIDER_UNAVAILABLE],
    ['application_error', null, MAIL_DELIVERY_FAILURES.AMBIGUOUS, MAIL_DELIVERY_REASONS.UNKNOWN]
  ] as const)(
    'maps %s (%s) to a bounded %s/%s result',
    async (name, status, failure, reason) => {
      const { send, mailer } = setup()
      send.mockResolvedValue(errorResponse(name, status))
      const result = await mailer.sendConfirmation(confirmationInput())
      expect(result).toEqual({ accepted: false, failure, reason })
      expect(JSON.stringify(result)).not.toContain('re_secret')
      expect(JSON.stringify(result)).not.toContain('raw-confirmation-token')
    }
  )

  it.each([
    ['concurrent_idempotent_requests', 409, MAIL_DELIVERY_REASONS.UNKNOWN],
    ['application_error', 500, MAIL_DELIVERY_REASONS.PROVIDER_UNAVAILABLE],
    ['service_unavailable', 503, MAIL_DELIVERY_REASONS.PROVIDER_UNAVAILABLE]
  ] as const)(
    'holds the delivery lease after %s (%s) instead of immediately sending a second email',
    async (name, status, reason) => {
      const { send, mailer } = setup()
      send
        .mockResolvedValueOnce(errorResponse(name, status))
        .mockResolvedValueOnce({
          data: { id: 'provider-message-2' },
          error: null,
          headers: null
        })
      let nowMs = now.getTime()
      const background: Promise<void>[] = []
      const newsletter = createNewsletter({
        storage: memoryStorage(),
        mailer,
        capabilities: createSecureCapabilities({ hmacSecret: secret }),
        clock: { now: () => new Date(nowMs) },
        confirmation: { deliveryLeaseMs: 1_000 },
        runBackground: task => { background.push(task) }
      })
      const settle = async () => {
        await Promise.all(background.splice(0))
      }

      await newsletter.subscribe({
        email: 'person@example.com',
        audience: 'product',
        consent: { granted: true, version: 'v1' }
      })
      await settle()
      const pending = await newsletter.getSubscription({
        email: 'person@example.com',
        audience: 'product'
      })
      expect(pending?.confirmationDelivery).toMatchObject({
        attemptId: expect.any(String),
        leaseExpiresAt: new Date(nowMs + 1_000)
      })
      expect(pending?.confirmationSentAt).toBeNull()
      expect((await newsletter.listEvents({ email: 'person@example.com' })).at(-1)).toMatchObject({
        type: NEWSLETTER_EVENT_TYPES.CONFIRMATION_SEND_FAILED,
        metadata: {
          outcome: MAIL_DELIVERY_FAILURES.AMBIGUOUS,
          reason,
          authoritative: true
        }
      })

      await newsletter.resendConfirmation({ email: 'person@example.com', audience: 'product' })
      await settle()
      expect(send).toHaveBeenCalledTimes(1)
      expect((await newsletter.getSubscription({
        email: 'person@example.com', audience: 'product'
      }))?.confirmationDelivery).toEqual(pending?.confirmationDelivery)

      nowMs += 1_000
      await newsletter.resendConfirmation({ email: 'person@example.com', audience: 'product' })
      await settle()
      expect(send).toHaveBeenCalledTimes(2)
      expect(send.mock.calls[1]?.[1]?.idempotencyKey)
        .not.toBe(send.mock.calls[0]?.[1]?.idempotencyKey)
      expect((await newsletter.getSubscription({
        email: 'person@example.com', audience: 'product'
      }))?.confirmationSentAt).toBeInstanceOf(Date)
    }
  )

  it('treats thrown transport failures and missing provider IDs as ambiguous', async () => {
    const { send, mailer } = setup()
    send.mockRejectedValueOnce(Object.assign(new Error('raw-confirmation-token'), {
      name: 'TimeoutError'
    }))
    await expect(mailer.sendConfirmation(confirmationInput())).resolves.toEqual({
      accepted: false,
      failure: MAIL_DELIVERY_FAILURES.AMBIGUOUS,
      reason: MAIL_DELIVERY_REASONS.TIMEOUT
    })
    send.mockRejectedValueOnce(new Error('re_secret transport'))
    await expect(mailer.sendConfirmation(confirmationInput())).resolves.toEqual({
      accepted: false,
      failure: MAIL_DELIVERY_FAILURES.AMBIGUOUS,
      reason: MAIL_DELIVERY_REASONS.UNKNOWN
    })
    send.mockResolvedValueOnce({ data: { id: '' }, error: null, headers: null })
    await expect(mailer.sendConfirmation(confirmationInput())).resolves.toEqual({
      accepted: false,
      failure: MAIL_DELIVERY_FAILURES.AMBIGUOUS,
      reason: MAIL_DELIVERY_REASONS.UNKNOWN
    })
  })

  it('rejects missing sender/credentials and never sends invalid or failed rendering', async () => {
    const { client, send } = setup()
    const renderConfirmation = () => ({ subject: 'Hello', text: 'Message' })
    expect(() => resendMailer({ from: '', client, renderConfirmation }))
      .toThrow('A sender and exactly one')
    expect(() => resendMailer({ from: 'news@example.com', renderConfirmation }))
      .toThrow('A sender and exactly one')
    expect(() => resendMailer({
      from: 'news@example.com', apiKey: 're_key', client, renderConfirmation
    })).toThrow('A sender and exactly one')

    const bad = resendMailer({
      from: 'news@example.com',
      client,
      renderConfirmation: () => ({ subject: '  ', html: ' ' })
    })
    await expect(bad.sendConfirmation(confirmationInput())).resolves.toEqual({
      accepted: false,
      failure: MAIL_DELIVERY_FAILURES.PERMANENT,
      reason: MAIL_DELIVERY_REASONS.RENDER_FAILED
    })
    const throws = resendMailer({
      from: 'news@example.com',
      client,
      renderConfirmation: () => { throw new Error('raw-confirmation-token') }
    })
    await expect(throws.sendConfirmation(confirmationInput())).resolves.toEqual({
      accepted: false,
      failure: MAIL_DELIVERY_FAILURES.TEMPORARY,
      reason: MAIL_DELIVERY_REASONS.RENDER_FAILED
    })
    expect(send).not.toHaveBeenCalled()
  })

  it('persists only sanitized reasons and marks sends accepted only on provider success', async () => {
    const { send, mailer } = setup()
    const storage = memoryStorage()
    const background: Promise<void>[] = []
    const newsletter = createNewsletter({
      storage,
      mailer,
      capabilities: createSecureCapabilities({ hmacSecret: secret }),
      clock: { now: () => now },
      runBackground: task => { background.push(task) }
    })
    send.mockResolvedValueOnce(errorResponse('validation_error', 422))
    await newsletter.subscribe({
      email: 'person@example.com',
      audience: 'product',
      consent: { granted: true, version: 'v1', locale: 'en' }
    })
    await Promise.all(background.splice(0))
    const pending = await newsletter.getSubscription({ email: 'person@example.com', audience: 'product' })
    expect(pending?.confirmationSentAt).toBeNull()
    expect(pending?.status).toBe(SUBSCRIPTION_STATUSES.PENDING_CONFIRMATION)
    const failed = (await newsletter.listEvents({ email: 'person@example.com' }))
      .find(event => event.type === NEWSLETTER_EVENT_TYPES.CONFIRMATION_SEND_FAILED)
    expect(failed?.metadata).toMatchObject({
      outcome: MAIL_DELIVERY_FAILURES.PERMANENT,
      reason: MAIL_DELIVERY_REASONS.INVALID_REQUEST
    })
    expect(JSON.stringify(failed)).not.toContain('re_secret')
    expect(JSON.stringify(failed)).not.toContain('raw-confirmation-token')

    send.mockResolvedValueOnce({ data: { id: 'provider-message-2' }, error: null, headers: null })
    await newsletter.resendConfirmation({ email: 'person@example.com', audience: 'product' })
    await Promise.all(background.splice(0))
    expect((await newsletter.getSubscription({
      email: 'person@example.com', audience: 'product'
    }))?.confirmationSentAt).toBeInstanceOf(Date)
  })

  it('normalizes an untrusted mailer reason instead of persisting raw provider text', async () => {
    const storage = memoryStorage()
    const background: Promise<void>[] = []
    const newsletter = createNewsletter({
      storage,
      capabilities: createSecureCapabilities({ hmacSecret: secret }),
      mailer: {
        async sendConfirmation() {
          return {
            accepted: false,
            failure: MAIL_DELIVERY_FAILURES.PERMANENT,
            reason: 're_secret raw-confirmation-token' as MailDeliveryReasonCode
          }
        }
      },
      runBackground: task => { background.push(task) }
    })
    await newsletter.subscribe({
      email: 'person@example.com',
      consent: { granted: true, version: 'v1' }
    })
    await Promise.all(background)
    const events = await newsletter.listEvents({ email: 'person@example.com' })
    expect(events.at(-1)?.metadata.reason).toBe(MAIL_DELIVERY_REASONS.UNKNOWN)
    expect(JSON.stringify(events)).not.toContain('re_secret')
    expect(JSON.stringify(events)).not.toContain('raw-confirmation-token')
  })
})
