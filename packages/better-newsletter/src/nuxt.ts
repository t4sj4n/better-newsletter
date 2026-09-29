import { existsSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import { addServerHandler, addServerTemplate, createResolver, defineNuxtModule } from '@nuxt/kit'
import type { NuxtModule } from 'nuxt/schema'
import { assertAudienceKey, DEFAULT_AUDIENCE_KEY } from './normalize.js'

export type NewsletterRoute = 'subscribe' | 'resendConfirmation' | 'confirm'
  | 'unsubscribe' | 'unsubscribeAll' | 'preferences'

export interface BetterNewsletterModuleOptions {
  defaultAudience: string
  audiences: Record<string, { public: boolean }>
  consent: { version: string; source: string }
  configFile: string
  routes: Record<NewsletterRoute, string | false>
}

export type BetterNewsletterUserOptions =
  Partial<Omit<BetterNewsletterModuleOptions, 'routes' | 'audiences' | 'consent'>> & {
    routes?: Partial<BetterNewsletterModuleOptions['routes']>
    audiences?: BetterNewsletterModuleOptions['audiences']
    consent?: Partial<BetterNewsletterModuleOptions['consent']>
  }

declare module 'nuxt/schema' {
  interface NuxtConfig {
    betterNewsletter?: BetterNewsletterUserOptions
  }
}

export const defaultNewsletterRoutes: BetterNewsletterModuleOptions['routes'] = {
  subscribe: '/api/newsletter/subscribe',
  resendConfirmation: '/api/newsletter/resend-confirmation',
  confirm: '/api/newsletter/confirm',
  unsubscribe: '/api/newsletter/unsubscribe',
  unsubscribeAll: '/api/newsletter/unsubscribe-all',
  preferences: '/api/newsletter/preferences'
}

const betterNewsletterModule: NuxtModule<BetterNewsletterModuleOptions> = defineNuxtModule<BetterNewsletterModuleOptions>({
  meta: {
    name: 'better-newsletter',
    configKey: 'betterNewsletter',
    compatibility: { nuxt: '^4.5.2' }
  },
  defaults: {
    defaultAudience: DEFAULT_AUDIENCE_KEY,
    audiences: { [DEFAULT_AUDIENCE_KEY]: { public: true } },
    consent: { version: 'v1', source: 'signup-form' },
    configFile: 'server/better-newsletter.config.ts',
    routes: defaultNewsletterRoutes
  },
  setup(options, nuxt) {
    assertAudienceKey(options.defaultAudience)
    if (typeof options.consent.version !== 'string'
      || typeof options.consent.source !== 'string'
      || !options.consent.version.trim() || !options.consent.source.trim()) {
      throw new Error('betterNewsletter.consent requires a version and source.')
    }
    for (const audience of Object.keys(options.audiences)) {
      assertAudienceKey(audience)
    }
    const configFile = resolvePath(nuxt.options.rootDir, options.configFile)
    if (!existsSync(configFile)) {
      throw new Error(`Newsletter server configuration not found: ${configFile}`)
    }
    addServerTemplate({
      filename: '#better-newsletter-config',
      getContents: () => `export { default } from ${JSON.stringify(configFile)}`
    })

    addServerTemplate({
      filename: '#better-newsletter-options',
      getContents: () => `export default ${JSON.stringify({
        defaultAudience: options.defaultAudience,
        audiences: options.audiences,
        consent: options.consent
      })}`
    })
    const { resolve } = createResolver(import.meta.url)
    // Nitro dev otherwise externalizes linked-package imports with paths
    // relative to its generated entry rather than to this package.
    const nitro = nuxt.options as typeof nuxt.options & {
      nitro: { externals?: { inline?: string[] } }
    }
    nitro.nitro.externals ??= {}
    nitro.nitro.externals.inline ??= []
    nitro.nitro.externals.inline.push(resolve('.'))
    const registered = new Set<string>()
    for (const action of Object.keys(defaultNewsletterRoutes) as NewsletterRoute[]) {
      const route = options.routes[action]
      if (route === false) continue
      if (typeof route !== 'string' || !route.startsWith('/') || route.startsWith('//')
        || route.includes('?') || route.includes('#') || registered.has(route)) {
        throw new Error(`Invalid or duplicate newsletter route: ${route}`)
      }
      registered.add(route)
      addServerHandler({
        route,
        method: 'post',
        handler: resolve(`./nuxt/routes/${action}.js`)
      })
    }
  }
})

export default betterNewsletterModule
