declare module '#better-newsletter-config' {
  import type { BetterNewsletterServerConfig } from './server.js'
  const config: () => BetterNewsletterServerConfig | Promise<BetterNewsletterServerConfig>
  export default config
}
