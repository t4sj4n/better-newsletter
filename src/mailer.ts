import type { Contact, Subscription } from './domain.js'

export interface ConfirmationMailInput {
  readonly contact: Contact
  readonly subscription: Subscription
  readonly token: string
  readonly expiresAt: Date
}

export interface MailDeliveryResult {
  readonly accepted: boolean
  readonly providerMessageId?: string
}

export interface NewsletterMailer {
  sendConfirmation(input: ConfirmationMailInput): Promise<MailDeliveryResult>
}
