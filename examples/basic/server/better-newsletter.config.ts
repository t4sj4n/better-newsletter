import { memoryCapabilities, memoryStorage } from 'better-newsletter/memory'
import { defineBetterNewsletterConfig } from 'better-newsletter/nuxt/server'
import { basicMailer, getBasicOrigin } from './utils/basic-state'

const storage = memoryStorage()
const capabilities = memoryCapabilities()

export default defineBetterNewsletterConfig(() => {
  if (!import.meta.dev) {
    throw new Error('The in-memory newsletter example is development-only.')
  }

  return {
    origin: getBasicOrigin(),
    storage,
    capabilities,
    mailer: basicMailer
  }
})
