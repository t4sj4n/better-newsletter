export interface NewsletterCopy {
  common: {
    loading: string
    error: string
  }
  validation: {
    email: string
    consent: string
  }
  signup: {
    email: string
    emailPlaceholder: string
    consent: string
    submit: string
    successTitle: string
    success: string
    error: string
  }
  resend: {
    email: string
    submit: string
    successTitle: string
    success: string
    error: string
  }
  confirmation: {
    submit: string
    successTitle: string
    success: string
    alreadyConfirmedTitle: string
    alreadyConfirmed: string
    expiredTitle: string
    expired: string
    invalidTitle: string
    invalid: string
    error: string
  }
  unsubscribe: {
    submit: string
    successTitle: string
    success: string
    invalidTitle: string
    invalid: string
    error: string
  }
}

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K]
}

export type NewsletterCopyOverrides = DeepPartial<NewsletterCopy>

export const defaultNewsletterCopy: NewsletterCopy = {
  common: {
    loading: 'Loading...',
    error: 'An error occurred'
  },
  validation: {
    email: 'Please enter a valid email address.',
    consent: 'You must agree before subscribing.'
  },
  signup: {
    email: 'Email address',
    emailPlaceholder: 'you@example.com',
    consent: 'I agree to receive the newsletter.',
    submit: 'Subscribe',
    successTitle: 'Check your inbox',
    success: 'Please confirm your subscription via the link sent to your email.',
    error: 'Failed to subscribe. Please try again.'
  },
  resend: {
    email: 'Email address',
    submit: 'Resend confirmation',
    successTitle: 'Confirmation email sent',
    success: 'If you signed up, a new confirmation link was sent.',
    error: 'Failed to resend confirmation. Please try again.'
  },
  confirmation: {
    submit: 'Confirm subscription',
    successTitle: 'Subscription confirmed',
    success: 'Thank you! Your newsletter subscription is confirmed.',
    alreadyConfirmedTitle: 'Already confirmed',
    alreadyConfirmed: 'This subscription is already active.',
    expiredTitle: 'Link expired',
    expired: 'This confirmation link has expired. Request a new one below.',
    invalidTitle: 'Invalid link',
    invalid: 'This confirmation link is invalid or incomplete.',
    error: 'Failed to confirm subscription. Please try again.'
  },
  unsubscribe: {
    submit: 'Unsubscribe',
    successTitle: 'Unsubscribed',
    success: 'You have been successfully unsubscribed from the newsletter.',
    invalidTitle: 'Invalid link',
    invalid: 'This unsubscribe link is invalid or incomplete.',
    error: 'Failed to unsubscribe. Please try again.'
  }
}

export function mergeNewsletterCopy(base: NewsletterCopy, overrides?: NewsletterCopyOverrides): NewsletterCopy {
  if (!overrides) return base
  const result: Record<string, unknown> = { ...base }
  for (const [sectionKey, sectionValue] of Object.entries(overrides)) {
    if (!sectionValue || typeof sectionValue !== 'object') continue
    const baseSection = (base as unknown as Record<string, unknown>)[sectionKey]
    result[sectionKey] = {
      ...(typeof baseSection === 'object' && baseSection !== null ? baseSection : {}),
      ...sectionValue
    }
  }
  return result as unknown as NewsletterCopy
}
