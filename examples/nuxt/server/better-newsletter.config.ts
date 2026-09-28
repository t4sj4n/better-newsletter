import { memoryCapabilities, memoryStorage } from 'better-newsletter/memory'
import { defineBetterNewsletterConfig } from 'better-newsletter/nuxt/server'
import { demoClock, demoMailer, getDemoOrigin } from './utils/demo-state'

// Deliberately process-local: restarting the example clears consent and links.
const storage = memoryStorage()
const capabilities = memoryCapabilities()

export default defineBetterNewsletterConfig(async () => {
  if (!import.meta.dev) {
    throw new Error('The in-memory newsletter example is development-only.')
  }

  return {
    // Application-owned, never inferred from an incoming Host header.
    origin: getDemoOrigin(),
    storage,
    capabilities,
    mailer: demoMailer,
    clock: demoClock,
    confirmation: {
      expiresInMs: 5 * 60 * 1000,
      deliveryLeaseMs: 10 * 1000
    }
  }
})
