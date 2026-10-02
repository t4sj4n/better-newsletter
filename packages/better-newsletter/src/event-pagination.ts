import { NewsletterError, NEWSLETTER_ERROR_CODES } from './errors.js'

function invalid(message: string): never {
  throw new NewsletterError(NEWSLETTER_ERROR_CODES.INVALID_PAGINATION, message)
}

export function eventPageLimit(limit: number | undefined): number {
  if (limit === undefined) return 50
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    invalid('Event page limit must be an integer between 1 and 100.')
  }
  return limit
}

export function encodeEventCursor(subscriptionId: string, sequence: string): string {
  const bytes = new TextEncoder().encode(JSON.stringify([1, subscriptionId, sequence]))
  return btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''))
    .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

export function decodeEventCursor(cursor: string): { subscriptionId: string; sequence: string } {
  try {
    if (typeof cursor !== 'string' || cursor.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
      throw new Error('Invalid encoding')
    }
    const binary = atob(cursor.replaceAll('-', '+').replaceAll('_', '/'))
    const decoded: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(
      Uint8Array.from(binary, char => char.charCodeAt(0))
    ))
    if (!Array.isArray(decoded) || decoded.length !== 3 || decoded[0] !== 1
      || typeof decoded[1] !== 'string' || decoded[1].length === 0
      || typeof decoded[2] !== 'string' || !/^[1-9][0-9]{0,18}$/.test(decoded[2])
      || BigInt(decoded[2]) > 9223372036854775807n
      || encodeEventCursor(decoded[1], decoded[2]) !== cursor) {
      throw new Error('Invalid payload')
    }
    return { subscriptionId: decoded[1], sequence: decoded[2] }
  } catch {
    return invalid('Invalid subscription event cursor.')
  }
}
