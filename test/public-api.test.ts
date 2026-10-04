import { describe, expect, it } from 'vitest'
import * as runtime from '../packages/better-newsletter/src/index.js'
import type {
  BetterNewsletter,
  BetterNewsletterOptions
} from '../packages/better-newsletter/src/index.js'
import { memoryAdapter } from '../packages/better-newsletter/src/adapters/memory.js'
import { postgresAdapter } from '../packages/better-newsletter/src/adapters/postgres.js'
import { resendMailer } from '../packages/better-newsletter/src/mailers/resend.js'
import { getMigrations } from '../packages/better-newsletter/src/db/migration.js'
import { createNewsletterClient } from '../packages/better-newsletter/src/client.js'
import { createNewsletterClient as createNewsletterClientFromNuxt } from '../packages/better-newsletter/src/nuxt/client.js'
import { createSecureCapabilities } from '../packages/better-newsletter/src/security.js'

describe('public API boundary', () => {
  it('exposes the branded initializer without old names or implementation primitives at the root', () => {
    const initializer: (options: BetterNewsletterOptions) => BetterNewsletter =
      runtime.betterNewsletter
    expect(initializer).toBeTypeOf('function')
    expect(runtime).not.toHaveProperty('createNewsletter')
    expect(runtime).not.toHaveProperty('sha256Digest')
    expect(runtime).not.toHaveProperty('createSecureCapabilities')
  })

  it('keeps specialized factories and migration helpers on their respective subpaths', () => {
    for (const factory of [
      memoryAdapter,
      postgresAdapter,
      resendMailer,
      getMigrations,
      createNewsletterClient,
      createNewsletterClientFromNuxt,
      createSecureCapabilities
    ]) {
      expect(factory).toBeTypeOf('function')
    }
    expect(createNewsletterClientFromNuxt).toBe(createNewsletterClient)
  })
})
