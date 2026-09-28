import BetterNewsletter from 'better-newsletter/nuxt'

export default defineNuxtConfig({
  modules: [BetterNewsletter],
  compatibilityDate: '2025-07-01',
  betterNewsletter: {
    defaultAudience: 'default',
    consent: {
      version: 'demo-privacy-v1',
      source: 'nuxt-demo'
    },
    audiences: {
      default: { public: true },
      'product-news': { public: true },
      'weekly-analysis': { public: true }
    }
  }
})
