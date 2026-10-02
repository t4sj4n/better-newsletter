import BetterNewsletter from 'better-newsletter/nuxt'

export default defineNuxtConfig({
  modules: process.env.SMOKE_WITH_NEWSLETTER === 'false' ? [] : [BetterNewsletter],
  compatibilityDate: '2025-07-01',
  betterNewsletter: {
    audiences: { default: { public: true } }
  }
})
