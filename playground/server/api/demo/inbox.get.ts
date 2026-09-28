import { useBetterNewsletter } from 'better-newsletter/nuxt/server'
import { getDemoMailerMode, getDemoMessages, getDemoOrigin } from '../../utils/demo-state'

export default defineEventHandler(async (event) => {
  if (!import.meta.dev) throw createError({ statusCode: 404 })
  setHeader(event, 'Cache-Control', 'no-store')

  const email = getQuery(event).email
  if (typeof email !== 'string' || !email.trim()) {
    throw createError({ statusCode: 400, statusMessage: 'Enter an email address.' })
  }

  const newsletter = await useBetterNewsletter(event)
  const contact = await newsletter.getContact({ email })
  const subscriptions = contact == null
    ? []
    : await newsletter.listSubscriptions({ email })
  const origin = getDemoOrigin()
  const confirmationLinks = getDemoMessages(email).map(({
    audience,
    token,
    expiresAt,
    lastDeliveredAt,
    acceptedDeliveries
  }) => {
    const url = new URL('/newsletter/confirm', origin)
    url.searchParams.set('token', token)
    return {
      audience,
      expiresAt,
      lastDeliveredAt,
      acceptedDeliveries,
      url: url.toString()
    }
  })

  const unsubscribeLinks = await Promise.all(subscriptions.map(async subscription => {
    const capability = await newsletter.createUnsubscribeCapability({
      email,
      audience: subscription.audienceKey
    })
    if (capability == null) return null
    const url = new URL('/newsletter/unsubscribe', origin)
    url.searchParams.set('capability', capability)
    return { audience: subscription.audienceKey, url: url.toString() }
  }))

  const allCapability = contact == null
    ? null
    : await newsletter.createUnsubscribeCapability({ email, all: true })
  const preferencesCapability = contact == null
    ? null
    : await newsletter.createManagePreferencesCapability({ email })
  const unsubscribeAllUrl = allCapability == null
    ? null
    : (() => {
        const url = new URL('/newsletter/unsubscribe', origin)
        url.searchParams.set('capability', allCapability)
        url.searchParams.set('all', '1')
        return url.toString()
      })()
  const preferencesUrl = preferencesCapability == null
    ? null
    : (() => {
        const url = new URL('/newsletter/preferences', origin)
        url.searchParams.set('capability', preferencesCapability)
        return url.toString()
      })()

  return {
    mailerMode: getDemoMailerMode(),
    contactStatus: contact?.status ?? null,
    subject: contact?.subject ?? null,
    subscriptions: subscriptions.map(subscription => ({
      audience: subscription.audienceKey,
      status: subscription.status
    })),
    confirmationLinks,
    unsubscribeLinks: unsubscribeLinks.filter(link => link != null),
    unsubscribeAllUrl,
    preferencesUrl
  }
})
