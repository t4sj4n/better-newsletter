import { createNewsletterClient, type NewsletterClient, type NewsletterRoutingOptions } from '../../../client.js'
import { useRuntimeConfig } from 'nuxt/app'

export function useNewsletterClient(): NewsletterClient {
  const config = useRuntimeConfig()
  const options = (config.public as Record<string, unknown>).betterNewsletter as NewsletterRoutingOptions | undefined
  return createNewsletterClient(options)
}
