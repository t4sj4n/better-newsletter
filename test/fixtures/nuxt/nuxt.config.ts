import BetterNewsletter from 'better-newsletter/nuxt'
import { defineNuxtConfig } from 'nuxt/config'

export default defineNuxtConfig({
  modules: [BetterNewsletter],
  betterNewsletter: {
    audiences: {
      default: { public: true },
      product: { public: true }
    }
  }
})
