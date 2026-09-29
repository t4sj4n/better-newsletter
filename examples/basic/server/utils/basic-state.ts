import type { ConfirmationMailInput, MailDeliveryResult } from 'better-newsletter/mailers'
import { newsletterUrl } from 'better-newsletter/nuxt/server'

interface FakeMail {
  subject: string
  text: string
  html: string
  confirmationUrl: string
}

const inbox = new Map<string, FakeMail>()

export function getBasicOrigin(): string {
  const origin = process.env.BASIC_APP_ORIGIN ?? 'http://localhost:3000'
  const url = new URL(origin)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
    || url.pathname !== '/' || url.search || url.hash
    || origin.replace(/\/$/u, '') !== url.origin) {
    throw new Error('BASIC_APP_ORIGIN must be a fixed HTTP(S) origin without credentials or a path.')
  }
  return url.origin
}

export function getFakeMail(email: string): FakeMail | null {
  return inbox.get(email) ?? null
}

export const basicMailer = {
  async sendConfirmation(input: ConfirmationMailInput): Promise<MailDeliveryResult> {
    const confirmationUrl = newsletterUrl(getBasicOrigin(), '/newsletter/confirm', input.token)
    inbox.set(input.contact.email, {
      subject: 'Confirm your newsletter subscription',
      text: `To confirm your newsletter subscription, open this link and press Confirm:\n${confirmationUrl}`,
      html: `<p>To confirm your newsletter subscription, open this link and press Confirm:</p><p><a href="${confirmationUrl}">Confirm subscription</a></p>`,
      confirmationUrl
    })
    return { accepted: true }
  }
}
