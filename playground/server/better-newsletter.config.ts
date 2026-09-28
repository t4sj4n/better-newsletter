import { memoryCapabilities, memoryStorage } from 'better-newsletter/memory'
import { resendMailer } from 'better-newsletter/resend'
import { defineBetterNewsletterConfig, newsletterUrl } from 'better-newsletter/nuxt/server'
import { demoClock, demoMailer, getDemoMailerMode, getDemoOrigin } from './utils/demo-state'

// Deliberately process-local: restarting the example clears consent and links.
const storage = memoryStorage()
const capabilities = memoryCapabilities()

function realMailer(origin: string) {
  const apiKey = process.env.RESEND_API_KEY?.trim()
  const from = process.env.DEMO_RESEND_FROM?.trim()
  if (!apiKey || !from) {
    throw new Error(
      'DEMO_MAILER=resend requires both RESEND_API_KEY and DEMO_RESEND_FROM.'
    )
  }

  return resendMailer({
    apiKey,
    from,
    renderConfirmation(input) {
      const confirmationUrl = newsletterUrl(
        origin,
        '/newsletter/confirm',
        input.token
      )
      return {
        subject: 'Confirm your newsletter subscription',
        text: [
          `Confirm your ${input.audienceKey} newsletter subscription by opening this link and pressing Confirm:`,
          confirmationUrl,
          '',
          'This message was sent from the better-newsletter development playground.'
        ].join('\n'),
        html: [
          `<p>Confirm your <strong>${input.audienceKey}</strong> newsletter subscription by opening this link and pressing Confirm:</p>`,
          `<p><a href="${confirmationUrl}">Confirm subscription</a></p>`,
          '<p>This message was sent from the better-newsletter development playground.</p>'
        ].join('')
      }
    }
  })
}

export default defineBetterNewsletterConfig(async () => {
  if (!import.meta.dev) {
    throw new Error('The newsletter playground is development-only.')
  }

  const origin = getDemoOrigin()
  const mailerMode = getDemoMailerMode()

  return {
    // Application-owned, never inferred from an incoming Host header.
    origin,
    storage,
    capabilities,
    mailer: mailerMode === 'resend' ? realMailer(origin) : demoMailer,
    clock: demoClock,
    confirmation: {
      expiresInMs: 5 * 60 * 1000,
      deliveryLeaseMs: 10 * 1000
    }
  }
})
