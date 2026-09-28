import BetterNewsletter from 'better-newsletter/nuxt'

export default defineNuxtConfig({
  modules: [BetterNewsletter],
  compatibilityDate: '2025-07-01',
  betterNewsletter: {
    defaultAudience: 'default',
    audiences: { default: { public: true } },
    consent: { version: 'basic-v1', source: 'basic-signup-form' },
    routes: {
      resendConfirmation: false,
      unsubscribeAll: false,
      preferences: false
    }
  }
})
