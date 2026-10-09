<script setup lang="ts">
import { createNewsletterClient } from 'better-newsletter/client'
import { createNewsletterClient as createLegacyNewsletterClient } from 'better-newsletter/nuxt/client'
const client = createNewsletterClient({ basePath: '/api/mail', routes: { preferences: '/manage' } })
const legacyClient = createLegacyNewsletterClient({ basePath: '/api/mail' })
const website = ref('')
const form = reactive({ email: '', consent: false })
const signup = useNewsletterSignup({
  email: toRef(form, 'email'), consent: toRef(form, 'consent'), clearOnSuccess: true, honeypot: website, client
})
const resend = useNewsletterResend({ email: signup.submittedEmail, client })
const confirmation = useNewsletterConfirm({ token: 'token', client })
const unsubscribe = useNewsletterUnsubscribe({ token: 'capability', client })
// Compile package-owned calls without relying on generated InternalApi.
function checkTypes() {
  const signupError: string | undefined = signup.errorMessage.value
  const submittedEmail: string | undefined = signup.submittedEmail.value
  const clearForm: () => void = signup.clearForm
  const resendError: string | undefined = resend.errorMessage.value
  const confirmationDescription: string = confirmation.resultDescription.value
  const unsubscribeDescription: string = unsubscribe.resultDescription.value
  void [signupError, resendError, confirmationDescription, unsubscribeDescription, clearForm, submittedEmail]
  // @ts-expect-error the submitted email snapshot is read-only
  signup.submittedEmail.value = 'another@example.com'
  void legacyClient.subscribe
  void client.subscribe({ email: 'packed@example.com', consent: true, consentVersion: 'packed-v1', website: website.value })
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
