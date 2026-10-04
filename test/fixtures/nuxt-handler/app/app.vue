<script setup lang="ts">
import { createNewsletterClient } from 'better-newsletter/client'
import { createNewsletterClient as createLegacyNewsletterClient } from 'better-newsletter/nuxt/client'
const client = createNewsletterClient({ basePath: '/api/mail', routes: { preferences: '/manage' } })
const legacyClient = createLegacyNewsletterClient({ basePath: '/api/mail' })
// Compile package-owned calls without relying on generated InternalApi.
function checkTypes() {
  void legacyClient.subscribe
  void client.subscribe({ email: 'packed@example.com', consent: true, consentVersion: 'packed-v1' })
  void client.resendConfirmation({ email: 'packed@example.com' })
  void client.confirm('token')
  void client.unsubscribe('capability')
  void client.unsubscribeAll('capability')
  void client.preferences('capability')
  // @ts-expect-error unknown actions are not part of the client
  void client.remove('capability')
  // @ts-expect-error confirmation takes a token, not arbitrary HTTP options
  void client.confirm({ method: 'GET', token: 'token' })
  // @ts-expect-error explicit consent is required
  void client.subscribe({ email: 'packed@example.com', consent: false, consentVersion: 'packed-v1' })
  // @ts-expect-error unknown routing actions fail compilation
  createNewsletterClient({ routes: { remove: '/remove' } })
}
void checkTypes
</script>
<template><div>Packed newsletter consumer</div></template>
