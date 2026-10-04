import { describe, expect, it } from 'vitest'
import { betterNewsletter } from '../packages/better-newsletter/src/index.js'
import { memoryAdapter, memoryCapabilities } from '../packages/better-newsletter/src/adapters/memory.js'

const email = 'person@example.com'
const consentedAt = new Date('2026-10-01T10:00:00Z')

async function fixture() {
  const storage = memoryAdapter()
  const options = {
    storage,
    capabilities: memoryCapabilities(),
    mailer: { async sendConfirmation() { return { accepted: true as const } } }
  }
  const newsletter = betterNewsletter(options)
  const subscription = await newsletter.importSubscription({
    email,
    status: 'PENDING_CONFIRMATION',
    consent: { version: 'v1', consentedAt }
  })
  return { storage, options, newsletter, subscription }
}

describe('confirmation replacement strategy validation', () => {
  it('rejects an invalid per-call strategy instead of silently retaining previous tokens', async () => {
    const { storage, newsletter, subscription } = await fixture()

    await expect(newsletter.createConfirmationToken({
      subscription: { id: subscription.id },
      replacementStrategy: 'INVALID' as never
    })).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' })

    expect(storage.confirmationTokenSnapshot()).toHaveLength(0)
  })

  it('rejects an invalid configured strategy when confirmation tokens are created', async () => {
    const { storage, options, subscription } = await fixture()
    const newsletter = betterNewsletter({
      ...options,
      confirmation: { replacementStrategy: 'INVALID' as never }
    })

    await expect(newsletter.createConfirmationToken({
      subscription: { id: subscription.id }
    })).rejects.toMatchObject({ code: 'INVALID_CONFIGURATION' })

    expect(storage.confirmationTokenSnapshot()).toHaveLength(0)
  })
})
