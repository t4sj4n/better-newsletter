import { memoryAdapter, memoryCapabilities, memoryRateLimiter } from 'better-newsletter/adapters/memory'
import { defineBetterNewsletterConfig } from 'better-newsletter/nuxt/server'

export const state = { tokens: [] as string[], disabled: false, securityCalls: 0, identities: 0 }
const storage = memoryAdapter()
const capabilities = memoryCapabilities()
const limiter = memoryRateLimiter()

export default defineBetterNewsletterConfig(event => ({
  origin: 'https://newsletter.example',
  storage,
  capabilities,
  publicApi: {
    consent: { version: 'packed-v1', source: 'packed-form' },
    audiences: { default: { public: true }, product: { public: true } },
    routes: { preferences: state.disabled ? false : '/manage' }
  },
  publicSubscribeMetadata: (currentEvent, body) => {
    if (currentEvent !== event) throw new Error('Server configuration must receive the current H3 event')
    return { placement: body.placement === 'pricing' ? 'pricing' : 'other' }
  },
  securityContext: (_event, body) => { state.securityCalls++; return { captcha: body.captcha } },
  abuseGuard: { verify: async ({ context }) => ({ allowed: (context as { captcha?: string })?.captcha === 'verified' }) },
  trustedClientIdentity: () => { state.identities++; return 'verified-network' },
  clientRateLimit: { secret: 'PACKED_SERVER_ONLY_SECRET_48_0123456789', limiter },
  mailer: { async sendConfirmation(input) { state.tokens.push(input.token); return { accepted: true } } },
  backgroundMode: 'await'
}))
