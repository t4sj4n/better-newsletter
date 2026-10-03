// Test-only trusted host endpoint; never shipped by the package.
import { useBetterNewsletter } from 'better-newsletter/nuxt/server'
import { state } from '../better-newsletter.config'

export default defineEventHandler(async event => {
  const body = await readBody(event)
  if (body.disable) state.disabled = true
  const service = await useBetterNewsletter(event)
  const email = 'packed@example.com'
  return {
    ...state,
    contact: await service.getContact({ email }),
    events: await service.listEvents({ email }),
    manage: await service.createManagePreferencesCapability({ email }),
    unsubscribe: await service.createUnsubscribeCapability({ email, audience: 'default' }),
    all: await service.createUnsubscribeCapability({ email, all: true })
  }
})
