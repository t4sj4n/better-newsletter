import { Resend } from 'resend'
import { DELIVERY_FEEDBACK_TYPES, type DeliveryFeedback } from '../domain.js'
import { NEWSLETTER_ERROR_CODES, NewsletterError } from '../errors.js'
import type { NewsletterService } from '../operations.js'

type ResendPayload = ReturnType<Resend['webhooks']['verify']>

export interface ResendWebhookInput {
  /** The exact raw request body, before JSON parsing or reserialization. */
  readonly payload: string
  readonly headers: Readonly<Record<string, string | undefined>>
}

export interface ResendWebhookOptions {
  readonly webhookSecret: string
  readonly newsletter: Pick<NewsletterService, 'processFeedback'>
}

function invalidWebhook(): NewsletterError {
  return new NewsletterError(NEWSLETTER_ERROR_CODES.INVALID_WEBHOOK, 'Invalid Resend webhook.')
}

function header(headers: ResendWebhookInput['headers'], name: string): string | undefined {
  return Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1]
}

/** Maps only feedback events with an unambiguous recipient. */
export function parseResendFeedback(
  payload: ResendPayload,
  providerEventId: string
): DeliveryFeedback | null {
  let type: DeliveryFeedback['type']
  let email: string
  if (payload.type === 'suppression.added') {
    type = DELIVERY_FEEDBACK_TYPES.PROVIDER_SUPPRESSION
    email = payload.data.email
  } else if (
    payload.type === 'email.bounced'
    || payload.type === 'email.complained'
    || payload.type === 'email.suppressed'
    || payload.type === 'email.delivered'
  ) {
    if (payload.data.to.length !== 1) throw invalidWebhook()
    email = payload.data.to[0]!
    if (payload.type === 'email.bounced') {
      type = payload.data.bounce.type === 'Permanent'
        ? DELIVERY_FEEDBACK_TYPES.HARD_BOUNCE
        : DELIVERY_FEEDBACK_TYPES.SOFT_BOUNCE
    } else if (payload.type === 'email.complained') {
      type = DELIVERY_FEEDBACK_TYPES.COMPLAINT
    } else if (payload.type === 'email.suppressed') {
      type = DELIVERY_FEEDBACK_TYPES.PROVIDER_SUPPRESSION
    } else {
      type = DELIVERY_FEEDBACK_TYPES.DELIVERED
    }
  } else {
    return null
  }
  const occurredAt = new Date(payload.created_at)
  if (!email || Number.isNaN(occurredAt.getTime())) throw invalidWebhook()
  return { provider: 'resend', providerEventId, email, type, occurredAt }
}

/** Verifies the Svix signature through Resend's SDK before parsing or processing. */
export function resendWebhook(options: ResendWebhookOptions) {
  if (!options.webhookSecret.startsWith('whsec_')) {
    throw new NewsletterError(
      NEWSLETTER_ERROR_CODES.INVALID_CONFIGURATION,
      'A Resend webhook signing secret is required.'
    )
  }
  const resend = new Resend('re_webhook_verification_only')
  return async (input: ResendWebhookInput) => {
    const id = header(input.headers, 'svix-id')
    const timestamp = header(input.headers, 'svix-timestamp')
    const signature = header(input.headers, 'svix-signature')
    if (!id || !timestamp || !signature || !input.payload) throw invalidWebhook()
    let payload: ResendPayload
    try {
      payload = resend.webhooks.verify({
        payload: input.payload,
        headers: { id, timestamp, signature },
        webhookSecret: options.webhookSecret
      })
    } catch {
      throw invalidWebhook()
    }
    let feedback: DeliveryFeedback | null
    try {
      feedback = parseResendFeedback(payload, id)
    } catch {
      throw invalidWebhook()
    }
    return feedback == null
      ? { processed: false, suppressed: false }
      : options.newsletter.processFeedback(feedback)
  }
}
