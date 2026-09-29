import { NEWSLETTER_ERROR_CODES, NewsletterError } from './errors.js'
import {
  MAIL_DELIVERY_FAILURES,
  MAIL_DELIVERY_REASONS,
  type ConfirmationMailInput,
  type MailDeliveryResult,
  type NewsletterMailer
} from './mailer.js'
import { sha256Digest } from './security.js'

export type ConfirmationEmailContent = { readonly subject: string } & (
  | { readonly html: string; readonly text?: string }
  | { readonly html?: string; readonly text: string }
)

type ResendEmailRequest = {
  readonly from: string
  readonly to: string
  readonly subject: string
  readonly replyTo?: string | string[]
} & (
  | { readonly html: string; readonly text?: string }
  | { readonly html?: string; readonly text: string }
)

interface ResendSendResponse {
  readonly data: { readonly id: string } | null
  readonly error: {
    readonly name: string
    readonly statusCode: number | null
    readonly message?: string
  } | null
  readonly headers?: Readonly<Record<string, string>> | null
}

export interface ResendEmailClient {
  readonly emails: {
    send(
      input: ResendEmailRequest,
      options: { readonly idempotencyKey: string }
    ): Promise<ResendSendResponse>
  }
}

export interface ResendMailerOptions {
  readonly apiKey?: string
  readonly client?: ResendEmailClient
  /** Uses the runtime's global fetch unless a custom transport is supplied. */
  readonly fetch?: typeof fetch
  readonly from: string
  readonly replyTo?: string | string[]
  readonly renderConfirmation: (
    input: ConfirmationMailInput
  ) => Promise<ConfirmationEmailContent> | ConfirmationEmailContent
}

function failedSend(error: NonNullable<ResendSendResponse['error']>): MailDeliveryResult {
  const { name, statusCode } = error
  if (statusCode != null && statusCode >= 500) {
    return {
      accepted: false,
      failure: MAIL_DELIVERY_FAILURES.AMBIGUOUS,
      reason: MAIL_DELIVERY_REASONS.PROVIDER_UNAVAILABLE
    }
  }
  if (
    name === 'rate_limit_exceeded'
    || name === 'daily_quota_exceeded'
    || name === 'monthly_quota_exceeded'
    || statusCode === 429
  ) {
    return {
      accepted: false,
      failure: MAIL_DELIVERY_FAILURES.TEMPORARY,
      reason: MAIL_DELIVERY_REASONS.RATE_LIMITED
    }
  }
  if (
    name === 'missing_api_key'
    || name === 'invalid_api_key'
    || name === 'restricted_api_key'
    || name === 'suspended_api_key'
    || name === 'invalid_permission'
    || statusCode === 401
  ) {
    return {
      accepted: false,
      failure: MAIL_DELIVERY_FAILURES.PERMANENT,
      reason: MAIL_DELIVERY_REASONS.AUTH_FAILED
    }
  }
  if (
    name === 'concurrent_idempotent_requests'
    || (statusCode === 409 && name !== 'invalid_idempotent_request')
  ) {
    return {
      accepted: false,
      failure: MAIL_DELIVERY_FAILURES.AMBIGUOUS,
      reason: MAIL_DELIVERY_REASONS.UNKNOWN
    }
  }
  if (
    name === 'validation_error'
    || name === 'invalid_from_address'
    || name === 'invalid_idempotency_key'
    || name === 'invalid_idempotent_request'
    || (statusCode != null && statusCode >= 400 && statusCode < 500)
  ) {
    return {
      accepted: false,
      failure: MAIL_DELIVERY_FAILURES.PERMANENT,
      reason: MAIL_DELIVERY_REASONS.INVALID_REQUEST
    }
  }
  return {
    accepted: false,
    failure: MAIL_DELIVERY_FAILURES.AMBIGUOUS,
    reason: MAIL_DELIVERY_REASONS.UNKNOWN
  }
}

async function sendWithApiKey(
  request: ResendEmailRequest,
  idempotencyKey: string,
  apiKey: string,
  fetcher: typeof fetch
): Promise<ResendSendResponse> {
  const response = await fetcher('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey
    },
    body: JSON.stringify({
      from: request.from,
      to: request.to,
      subject: request.subject,
      ...(request.replyTo !== undefined ? { reply_to: request.replyTo } : {}),
      ...(request.html !== undefined ? { html: request.html } : {}),
      ...(request.text !== undefined ? { text: request.text } : {})
    })
  })

  if (!response.ok) {
    let name = 'unknown'
    try {
      const body: unknown = await response.json()
      if (typeof body === 'object' && body !== null && 'name' in body && typeof body.name === 'string') {
        name = body.name
      }
    } catch {
      // The HTTP status still determines whether this rejection is retryable.
    }
    return { data: null, error: { name, statusCode: response.status } }
  }

  const body: unknown = await response.json()
  return {
    data: typeof body === 'object' && body !== null && 'id' in body && typeof body.id === 'string'
      ? { id: body.id }
      : null,
    error: null
  }
}

/**
 * Sends only confirmation lifecycle mail. The host owns URLs and rendering;
 * Resend is never used as a consent or subscription store.
 */
export function resendMailer(options: ResendMailerOptions): NewsletterMailer {
  if (
    options.from.trim().length === 0
    || (options.apiKey !== undefined && options.apiKey.trim().length === 0)
    || (options.client !== undefined && options.apiKey !== undefined)
  ) {
    throw new NewsletterError(
      NEWSLETTER_ERROR_CODES.INVALID_CONFIGURATION,
      'A sender and exactly one of a Resend API key or client are required.'
    )
  }

  let send: (
    request: ResendEmailRequest,
    idempotencyKey: string
  ) => Promise<ResendSendResponse>
  if (options.client !== undefined) {
    const client = options.client
    send = (request, idempotencyKey) => client.emails.send(request, { idempotencyKey })
  } else if (options.apiKey !== undefined) {
    const apiKey = options.apiKey
    send = (request, idempotencyKey) =>
      sendWithApiKey(request, idempotencyKey, apiKey, options.fetch ?? fetch)
  } else {
    throw new NewsletterError(
      NEWSLETTER_ERROR_CODES.INVALID_CONFIGURATION,
      'A sender and exactly one of a Resend API key or client are required.'
    )
  }

  return {
    async sendConfirmation(input) {
      let rendered: ConfirmationEmailContent
      try {
        rendered = await options.renderConfirmation(input)
      } catch {
        return {
          accepted: false,
          failure: MAIL_DELIVERY_FAILURES.TEMPORARY,
          reason: MAIL_DELIVERY_REASONS.RENDER_FAILED
        }
      }
      const content = rendered?.html !== undefined
        ? {
            html: rendered.html,
            ...(rendered.text !== undefined ? { text: rendered.text } : {})
          }
        : rendered?.text !== undefined
          ? { text: rendered.text }
          : null
      if (
        rendered == null
        || rendered.subject.trim().length === 0
        || content == null
        || (
          (rendered.html?.trim().length ?? 0) === 0
          && (rendered.text?.trim().length ?? 0) === 0
        )
      ) {
        return {
          accepted: false,
          failure: MAIL_DELIVERY_FAILURES.PERMANENT,
          reason: MAIL_DELIVERY_REASONS.RENDER_FAILED
        }
      }

      const idempotencyKey = `bn-confirmation/${await sha256Digest(JSON.stringify([
        input.deliveryId,
        input.attemptId,
        input.lifecycleGeneration
      ]))}`
      try {
        const request = {
          from: options.from,
          to: input.contact.email,
          subject: rendered.subject,
          ...content,
          ...(options.replyTo !== undefined ? { replyTo: options.replyTo } : {})
        }
        const response = await send(request, idempotencyKey)
        if (response.error != null) return failedSend(response.error)
        if (response.data?.id == null || response.data.id.length === 0) {
          return {
            accepted: false,
            failure: MAIL_DELIVERY_FAILURES.AMBIGUOUS,
            reason: MAIL_DELIVERY_REASONS.UNKNOWN
          }
        }
        return { accepted: true, providerMessageId: response.data.id }
      } catch (error) {
        return {
          accepted: false,
          failure: MAIL_DELIVERY_FAILURES.AMBIGUOUS,
          reason: error instanceof Error
            && (error.name === 'AbortError' || error.name === 'TimeoutError')
            ? MAIL_DELIVERY_REASONS.TIMEOUT
            : MAIL_DELIVERY_REASONS.UNKNOWN
        }
      }
    }
  }
}
