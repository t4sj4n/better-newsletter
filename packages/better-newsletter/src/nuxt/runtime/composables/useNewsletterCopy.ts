import { computed, toValue, type ComputedRef, type MaybeRefOrGetter } from 'vue'
import { useNuxtApp, useRuntimeConfig } from 'nuxt/app'
import { defaultNewsletterCopy, mergeNewsletterCopy, type NewsletterCopy, type NewsletterCopyOverrides } from '../copy.js'

interface NuxtI18nInstance {
  messages?: Record<string, Record<string, unknown>>
  locale?: { value?: string } | string
}

export type NewsletterCopySource = MaybeRefOrGetter<NewsletterCopyOverrides | undefined>

export function useNewsletterCopy(source?: NewsletterCopySource): ComputedRef<NewsletterCopy> {
  const nuxtApp = useNuxtApp()
  const config = useRuntimeConfig()
  const publicConfig = config.public as Record<string, unknown>
  const betterNewsletterConfig = publicConfig.betterNewsletter as { copy?: NewsletterCopyOverrides } | undefined
  const runtimeCopy = betterNewsletterConfig?.copy

  return computed<NewsletterCopy>(() => {
    const overrides = toValue(source) ?? runtimeCopy
    const i18n = (nuxtApp as unknown as { $i18n?: NuxtI18nInstance }).$i18n
    if (!i18n) return mergeNewsletterCopy(defaultNewsletterCopy, overrides)

    const locale = typeof i18n.locale === 'object' ? i18n.locale?.value : i18n.locale
    const localized = (locale ? (i18n.messages?.[locale]?.betterNewsletter as NewsletterCopyOverrides | undefined) : undefined)
      ?? (i18n.messages?.en?.betterNewsletter as NewsletterCopyOverrides | undefined)
    return mergeNewsletterCopy(mergeNewsletterCopy(defaultNewsletterCopy, localized), overrides)
  })
}
