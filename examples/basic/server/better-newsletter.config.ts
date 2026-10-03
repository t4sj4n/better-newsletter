import { memoryCapabilities, memoryAdapter } from 'better-newsletter/adapters/memory'
import { defineBetterNewsletterConfig } from 'better-newsletter/nuxt/server'
import { basicMailer, getBasicOrigin } from './utils/basic-state'

const storage = memoryAdapter()
const capabilities = memoryCapabilities()

export default defineBetterNewsletterConfig(() => {
  if (!import.meta.dev) {
    throw new Error('The in-memory newsletter example is development-only.')
  }

  return {
    publicApi: {
      defaultAudience: 'default',
      audiences: { default: { public: true } },
      consent: { version: 'basic-v1', source: 'basic-signup-form' },
      routes: {
        resendConfirmation: false,
        unsubscribeAll: false,
        preferences: false
      }
    },
    origin: getBasicOrigin(),
    storage,
    capabilities,
    mailer: basicMailer
  }
})
