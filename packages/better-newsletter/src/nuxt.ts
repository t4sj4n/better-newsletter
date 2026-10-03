import { existsSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import { addServerHandler, addServerTemplate, createResolver, defineNuxtModule } from '@nuxt/kit'
import type { NuxtModule } from 'nuxt/schema'
import { assertNewsletterBasePath } from './nuxt/routing.js'

export interface BetterNewsletterModuleOptions {
  basePath: string
  configFile: string
}

export type BetterNewsletterUserOptions = Partial<BetterNewsletterModuleOptions>

declare module 'nuxt/schema' {
  interface NuxtConfig {
    betterNewsletter?: BetterNewsletterUserOptions
  }
}

const betterNewsletterModule: NuxtModule<BetterNewsletterModuleOptions> = defineNuxtModule<BetterNewsletterModuleOptions>({
  meta: {
    name: 'better-newsletter',
    configKey: 'betterNewsletter',
    compatibility: { nuxt: '^4.5.2' }
  },
  defaults: {
    basePath: '/api/newsletter',
    configFile: 'server/better-newsletter.config.ts'
  },
  setup(options, nuxt) {
    for (const key of ['defaultAudience', 'audiences', 'consent', 'routes']) {
      if (Object.hasOwn(options, key)) {
        throw new Error(`Move betterNewsletter.${key} to publicApi.${key} in the server configuration.`)
      }
    }
    assertNewsletterBasePath(options.basePath)
    const configFile = resolvePath(nuxt.options.rootDir, options.configFile)
    if (!existsSync(configFile)) {
      throw new Error(`Newsletter server configuration not found: ${configFile}`)
    }
    addServerTemplate({
      filename: '#better-newsletter-config',
      getContents: () => `export { default } from ${JSON.stringify(configFile)}`
    })
    const { resolve } = createResolver(import.meta.url)
    addServerTemplate({
      filename: '#better-newsletter-handler',
      getContents: () => `import { createNewsletterHandler } from ${JSON.stringify(resolve('./nuxt/handler.js'))};
export default createNewsletterHandler(${JSON.stringify({ basePath: options.basePath })});`
    })
    // Nitro dev otherwise externalizes linked-package imports with paths
    // relative to its generated entry rather than to this package.
    const nitro = nuxt.options as typeof nuxt.options & {
      nitro: { externals?: { inline?: string[] } }
    }
    nitro.nitro.externals ??= {}
    nitro.nitro.externals.inline ??= []
    nitro.nitro.externals.inline.push(resolve('.'))
    addServerHandler({
      route: `${options.basePath}/**`,
      handler: '#better-newsletter-handler'
    })
  }
})

export default betterNewsletterModule
