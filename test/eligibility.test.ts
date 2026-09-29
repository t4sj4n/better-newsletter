import { describe, expect, it } from 'vitest'
import {
  CONTACT_STATUSES,
  DELIVERY_INELIGIBILITY_REASONS,
  getDeliveryEligibility,
  SUBSCRIPTION_STATUSES,
  type Contact,
  type Subscription
} from '../packages/better-newsletter/src/index.js'

const now = new Date('2026-09-28T08:00:00.000Z')

function contact(overrides: Partial<Contact> = {}): Contact {
  return {
    id: 'contact-1',
    capabilityGeneration: 1,
    email: 'person@example.com',
    status: CONTACT_STATUSES.ENABLED,
    subject: null,
    createdAt: now,
    updatedAt: now,
    ...overrides
  }
}

function subscription(
  audienceKey: string,
  overrides: Partial<Subscription> = {}
): Subscription {
  return {
    id: `subscription-${audienceKey}`,
    lifecycleGeneration: 1,
    confirmationDelivery: null,
    contactId: 'contact-1',
    audienceKey,
    status: SUBSCRIPTION_STATUSES.ACTIVE,
    consent: {
      version: 'v1',
      consentedAt: now
    },
    confirmedAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides
  }
}

describe('delivery eligibility', () => {
  it('supports independent subscriptions for one contact', () => {
    const newsletterContact = contact()
    const defaultSubscription = subscription('default')
    const productNews = subscription('product-news', {
      status: SUBSCRIPTION_STATUSES.UNSUBSCRIBED,
      unsubscribedAt: now
    })

    expect(getDeliveryEligibility(
      newsletterContact,
      defaultSubscription
    )).toEqual({ eligible: true })

    expect(getDeliveryEligibility(
      newsletterContact,
      productNews
    )).toEqual({
      eligible: false,
      reason: DELIVERY_INELIGIBILITY_REASONS.UNSUBSCRIBED
    })
  })

  it('globally suppresses delivery without changing subscription consent', () => {
    const newsletterContact = contact({
      status: CONTACT_STATUSES.SUPPRESSED,
      suppressedAt: now,
      suppressionReason: 'BOUNCE'
    })
    const activeSubscription = subscription('default')

    expect(getDeliveryEligibility(
      newsletterContact,
      activeSubscription
    )).toEqual({
      eligible: false,
      reason: DELIVERY_INELIGIBILITY_REASONS.CONTACT_SUPPRESSED
    })

    expect(activeSubscription.status).toBe(SUBSCRIPTION_STATUSES.ACTIVE)
  })

  it('requires confirmation for an active subscription', () => {
    const result = getDeliveryEligibility(
      contact(),
      subscription('default', {
        confirmedAt: null
      })
    )

    expect(result).toEqual({
      eligible: false,
      reason: DELIVERY_INELIGIBILITY_REASONS.NOT_CONFIRMED
    })
  })

  it('rejects a subscription belonging to a different contact', () => {
    const result = getDeliveryEligibility(
      contact(),
      subscription('default', {
        contactId: 'contact-2'
      })
    )

    expect(result).toEqual({
      eligible: false,
      reason: DELIVERY_INELIGIBILITY_REASONS.CONTACT_MISMATCH
    })
  })
})
