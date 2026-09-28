import { normalizeAndValidateEmail, SUBSCRIPTION_STATUSES } from 'better-newsletter'
import { useBetterNewsletter } from 'better-newsletter/nuxt/server'
import { getBasicOrigin, getFakeMail } from '../../utils/basic-state'

export default defineEventHandler(async (event) => {
  if (!import.meta.dev) throw createError({ statusCode: 404 })
  setHeader(event, 'Cache-Control', 'no-store')
  setHeader(event, 'Referrer-Policy', 'no-referrer')

  const address = getQuery(event).email
  if (typeof address !== 'string') {
    throw createError({ statusCode: 400, statusMessage: 'Enter an email address.' })
  }
  let email: string
  try {
    email = normalizeAndValidateEmail(address)
  } catch {
    throw createError({ statusCode: 400, statusMessage: 'Enter a valid email address.' })
  }

  const newsletter = await useBetterNewsletter(event)
  const subscription = await newsletter.getSubscription({ email })
  const mail = getFakeMail(email)
  const capability = subscription?.status !== SUBSCRIPTION_STATUSES.ACTIVE
    ? null
    : await newsletter.createUnsubscribeCapability({ email })
  const unsubscribeUrl = capability == null
    ? null
    : (() => {
        const url = new URL('/newsletter/unsubscribe', getBasicOrigin())
        url.searchParams.set('capability', capability)
        return url.toString()
      })()

  return {
    mail: subscription?.status === SUBSCRIPTION_STATUSES.PENDING_CONFIRMATION && mail != null
      ? { subject: mail.subject, text: mail.text, confirmationUrl: mail.confirmationUrl }
      : null,
    status: subscription?.status ?? null,
    unsubscribeUrl
  }
})
