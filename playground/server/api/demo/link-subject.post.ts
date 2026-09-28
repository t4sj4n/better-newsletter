import { useBetterNewsletter } from 'better-newsletter/nuxt/server'

export default defineEventHandler(async (event) => {
  if (!import.meta.dev) throw createError({ statusCode: 404 })

  // Fixed server-owned fixture, NOT an identity derived from the request body or headers.
  const session = { id: 'demo-member-001', email: 'demo-member@example.com' }
  const newsletter = await useBetterNewsletter(event)
  const contact = await newsletter.linkSubject({
    email: session.email,
    subject: { namespace: 'demo-user', id: session.id }
  })
  if (contact == null) {
    throw createError({ statusCode: 409, statusMessage: 'Sign up the demo member first.' })
  }
  return { subject: contact.subject }
})
