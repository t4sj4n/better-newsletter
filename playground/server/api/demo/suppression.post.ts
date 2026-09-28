import { useBetterNewsletter } from 'better-newsletter/nuxt/server'

export default defineEventHandler(async (event) => {
  if (!import.meta.dev) throw createError({ statusCode: 404 })
  const body = await readBody(event)
  if (
    typeof body?.email !== 'string'
    || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(body.email)
    || typeof body?.suppressed !== 'boolean'
  ) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid demo operation.' })
  }

  const newsletter = await useBetterNewsletter(event)
  const contact = body.suppressed
    ? await newsletter.suppressContact({ email: body.email, reason: 'DEMO_MANUAL' })
    : await newsletter.unsuppressContact({ email: body.email })
  if (contact == null) {
    throw createError({ statusCode: 404, statusMessage: 'Sign up first.' })
  }
  return { contactStatus: contact.status }
})
