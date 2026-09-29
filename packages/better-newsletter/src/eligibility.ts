import {
  CONTACT_STATUSES,
  SUBSCRIPTION_STATUSES,
  type Contact,
  type Subscription
} from './domain.js'

export const DELIVERY_INELIGIBILITY_REASONS = {
  CONTACT_MISMATCH: 'CONTACT_MISMATCH',
  CONTACT_SUPPRESSED: 'CONTACT_SUPPRESSED',
  PENDING_CONFIRMATION: 'PENDING_CONFIRMATION',
  UNSUBSCRIBED: 'UNSUBSCRIBED',
  NOT_CONFIRMED: 'NOT_CONFIRMED'
} as const

export type DeliveryIneligibilityReason =
  typeof DELIVERY_INELIGIBILITY_REASONS[keyof typeof DELIVERY_INELIGIBILITY_REASONS]

export type DeliveryEligibility =
  | { readonly eligible: true }
  | {
    readonly eligible: false
    readonly reason: DeliveryIneligibilityReason
  }

export function getDeliveryEligibility(
  contact: Contact,
  subscription: Subscription
): DeliveryEligibility {
  if (subscription.contactId !== contact.id) {
    return {
      eligible: false,
      reason: DELIVERY_INELIGIBILITY_REASONS.CONTACT_MISMATCH
    }
  }

  if (contact.status === CONTACT_STATUSES.SUPPRESSED) {
    return {
      eligible: false,
      reason: DELIVERY_INELIGIBILITY_REASONS.CONTACT_SUPPRESSED
    }
  }

  if (
    subscription.status === SUBSCRIPTION_STATUSES.UNSUBSCRIBED
    || subscription.unsubscribedAt != null
  ) {
    return {
      eligible: false,
      reason: DELIVERY_INELIGIBILITY_REASONS.UNSUBSCRIBED
    }
  }

  if (subscription.status === SUBSCRIPTION_STATUSES.PENDING_CONFIRMATION) {
    return {
      eligible: false,
      reason: DELIVERY_INELIGIBILITY_REASONS.PENDING_CONFIRMATION
    }
  }

  if (subscription.confirmedAt == null) {
    return {
      eligible: false,
      reason: DELIVERY_INELIGIBILITY_REASONS.NOT_CONFIRMED
    }
  }

  return { eligible: true }
}

export function isEligibleForDelivery(
  contact: Contact,
  subscription: Subscription
): boolean {
  return getDeliveryEligibility(contact, subscription).eligible
}
