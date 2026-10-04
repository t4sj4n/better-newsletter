declare module '#better-newsletter-config' {
  import type { defineBetterNewsletterConfig } from './server.js'
  const config: ReturnType<typeof defineBetterNewsletterConfig>
  export default config
}
