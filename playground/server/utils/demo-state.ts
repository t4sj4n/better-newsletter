import type { ConfirmationMailInput, MailDeliveryResult } from 'better-newsletter'

export interface DemoMessage {
  audience: string
  token: string
  expiresAt: string
  lastDeliveredAt: string
  acceptedDeliveries: number
}

export type DemoMailerMode = 'fake' | 'resend'
export type DemoStorageMode = 'memory' | 'postgres'
type Failure = 'TEMPORARY' | 'AMBIGUOUS'

const messages = new Map<string, Map<string, DemoMessage>>()
const failures = new Map<string, Failure>()
let clockOffsetMs = 0

export function getDemoMailerMode(): DemoMailerMode {
  const mode = process.env.DEMO_MAILER?.trim().toLowerCase()
  if (mode == null || mode === '' || mode === 'fake') return 'fake'
  if (mode === 'resend') return 'resend'
  throw new Error('DEMO_MAILER must be either "fake" or "resend".')
}

export function getDemoStorageMode(): DemoStorageMode {
  const mode = process.env.DEMO_STORAGE?.trim().toLowerCase()
  if (mode == null || mode === '' || mode === 'memory') return 'memory'
  if (mode === 'postgres') return 'postgres'
  throw new Error('DEMO_STORAGE must be either "memory" or "postgres".')
}

export function getDemoOrigin(): string {
  const url = new URL(process.env.DEMO_APP_ORIGIN ?? 'http://localhost:3000')
  if (
    !['http:', 'https:'].includes(url.protocol)
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash
  ) {
    throw new Error('DEMO_APP_ORIGIN must be an HTTP(S) origin without a path or credentials.')
  }
  return url.origin
}

function key(email: string, audience: string): string {
  return `${email.trim().toLowerCase()}\u0000${audience}`
}

export const demoClock = {
  now: () => new Date(Date.now() + clockOffsetMs)
}

export function advanceDemoClock(milliseconds: number): number {
  clockOffsetMs += milliseconds
  return clockOffsetMs
}

export function setNextFailure(email: string, audience: string, failure: Failure): void {
  failures.set(key(email, audience), failure)
}

export function getDemoMessages(email: string): DemoMessage[] {
  return [...(messages.get(email.trim().toLowerCase())?.values() ?? [])]
}

export const demoMailer = {
  async sendConfirmation(input: ConfirmationMailInput): Promise<MailDeliveryResult> {
    const email = input.contact.email
    const id = key(email, input.audienceKey)
    const failure = failures.get(id)
    if (failure != null) {
      failures.delete(id)
      return failure === 'TEMPORARY'
        ? { accepted: false, failure, reason: 'PROVIDER_UNAVAILABLE' }
        : { accepted: false, failure, reason: 'TIMEOUT' }
    }

    let byAudience = messages.get(email)
    if (byAudience == null) {
      byAudience = new Map()
      messages.set(email, byAudience)
    }
    const previous = byAudience.get(input.audienceKey)
    byAudience.set(input.audienceKey, {
      audience: input.audienceKey,
      token: input.token,
      expiresAt: input.expiresAt.toISOString(),
      lastDeliveredAt: demoClock.now().toISOString(),
      acceptedDeliveries: (previous?.acceptedDeliveries ?? 0) + 1
    })
    return { accepted: true }
  }
}
