export const DEFAULT_AUDIENCE_KEY = 'default'

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

export function assertAudienceKey(audienceKey: string): string {
  const normalized = audienceKey.trim()

  if (normalized.length === 0 || normalized.length > 128) {
    throw new TypeError('Audience key must contain between 1 and 128 characters.')
  }

  return normalized
}
