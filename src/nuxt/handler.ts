import { createError, getMethod, type H3Event } from 'h3'
import {
  NEWSLETTER_ERROR_CODES,
  NewsletterError,
  normalizeAndValidateEmail
} from '../index.js'
import type { BetterNewsletterModuleOptions, NewsletterRoute } from '../nuxt.js'
import { flushBetterNewsletter, newsletterSecurityContext, subscribeNewsletterAudiences, useBetterNewsletter, type BetterNewsletterServerConfig } from './server.js'

type PublicOptions = Pick<BetterNewsletterModuleOptions, 'defaultAudience' | 'audiences' | 'consent'>

const accepted = Object.freeze({ accepted: true as const })

function text(value: unknown, maxLength = 4096): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid newsletter request.' })
  }
  return value
}

async function payload(event: H3Event): Promise<Record<string, unknown>> {
  const chunks: Uint8Array[] = []
  let bytes = 0
  const stream = event.web?.request?.body ?? event.node.req
  for await (const chunk of stream) {
    bytes += chunk.byteLength
    if (bytes > 8192) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid newsletter request.' })
    }
    chunks.push(chunk)
  }
  const raw = new TextDecoder().decode(Buffer.concat(chunks))
  try {
    const value: unknown = JSON.parse(raw)
    if (value == null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Not an object')
    }
    return value as Record<string, unknown>
  } catch {
    throw createError({ statusCode: 400, statusMessage: 'Invalid newsletter request.' })
  }
}

export async function handleNewsletterRequest(
  event: H3Event,
  action: NewsletterRoute,
  options: PublicOptions,
  configuration?: BetterNewsletterServerConfig
): Promise<unknown> {
  if (getMethod(event) !== 'POST') {
    throw createError({ statusCode: 405, statusMessage: 'Method not allowed.' })
  }
  const body = await payload(event)
  if (action === 'subscribe' || action === 'resendConfirmation') {
    let email: string
    try {
      email = normalizeAndValidateEmail(text(body.email, 254))
    } catch (error) {
      if (!(error instanceof NewsletterError)) throw error
      throw createError({ statusCode: 400, statusMessage: 'Invalid newsletter request.' })
    }
    if ((body.audience !== undefined && (typeof body.audience !== 'string' || body.audiences !== undefined))
      || (body.audiences !== undefined && (action !== 'subscribe' || !Array.isArray(body.audiences)))) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid newsletter audience.' })
    }
    const requested = action === 'subscribe' && Array.isArray(body.audiences)
      ? body.audiences : [body.audience ?? options.defaultAudience]
    if (requested.length === 0 || requested.length > 10
      || requested.some(audience => typeof audience !== 'string'
        || options.audiences[audience]?.public !== true)
      || new Set(requested).size !== requested.length) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid newsletter audience.' })
    }
    if (action === 'subscribe' && (body.consent !== true
      || body.consentVersion !== options.consent.version)) {
      throw createError({ statusCode: 400, statusMessage: 'Explicit consent is required.' })
    }
    if (body.website != null && (typeof body.website !== 'string' || body.website.length > 512)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid newsletter request.' })
    }
    if (body.website) return accepted
    const service = await useBetterNewsletter(event, configuration)
    const securityContext = await newsletterSecurityContext(event, body)
    try {
      if (action === 'subscribe') {
        await subscribeNewsletterAudiences(event, (requested as string[]).map(audience => ({
          email,
          audience,
          consent: {
            granted: true,
            version: options.consent.version,
            source: options.consent.source
          },
          ...(securityContext === undefined ? {} : { securityContext })
        })))
      } else {
        await service.resendConfirmation({
          email,
          audience: requested[0] as string,
          ...(securityContext === undefined ? {} : { securityContext })
        })
      }
    } catch (error) {
      if (error instanceof NewsletterError && (
        error.code === NEWSLETTER_ERROR_CODES.RATE_LIMITED
        || error.code === NEWSLETTER_ERROR_CODES.ABUSE_REJECTED
      )) return accepted
      throw error
    } finally {
      await flushBetterNewsletter(event)
    }
    return accepted
  }

  const capability = action === 'confirm' ? text(body.token) : text(body.capability)
  const service = await useBetterNewsletter(event, configuration)
  if (action === 'confirm') return service.confirm({ token: capability })
  if (action === 'unsubscribe') return service.unsubscribe({ capability })
  if (action === 'unsubscribeAll') return service.unsubscribeAll({ capability })
  return { subscriptions: await service.listPreferences({ capability }) }
}
