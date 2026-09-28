declare module '#better-newsletter-config' {
  import type { BetterNewsletterServerConfig } from './server.js'
  const config: () => BetterNewsletterServerConfig | Promise<BetterNewsletterServerConfig>
  export default config
}

declare module '#better-newsletter-options' {
  import type { BetterNewsletterModuleOptions } from '../nuxt.js'
  const options: Pick<BetterNewsletterModuleOptions, 'defaultAudience' | 'audiences' | 'consent'>
  export default options
}
