import { memoryAdapter, memoryCapabilities } from 'better-newsletter/adapters/memory'
import { defineBetterNewsletterConfig } from 'better-newsletter/nuxt/server'

const storage = memoryAdapter()
const capabilities = memoryCapabilities()

export default defineBetterNewsletterConfig(() => ({
  origin: 'https://newsletter.example',
  storage,
  capabilities,
  mailer: {
    async sendConfirmation() {
      return { accepted: false, failure: 'TEMPORARY' }
    }
  }
}))
