<script setup lang="ts">
interface Inbox {
  mail: {
    subject: string
    text: string
    confirmationUrl: string
  } | null
  status: string | null
  unsubscribeUrl: string | null
}

const email = ref('')
const consent = ref(false)
const inbox = ref<Inbox | null>(null)
const message = ref('')
const busy = ref(false)

let inboxRequest = 0
watch(email, () => {
  inboxRequest += 1
  inbox.value = null
}, { flush: 'sync' })

async function refreshInbox() {
  const request = ++inboxRequest
  const address = email.value.trim()
  inbox.value = null
  if (!address) return
  try {
    const result = await $fetch<Inbox>('/api/example/inbox', {
      method: 'POST',
      body: { email: address }
    })
    if (request === inboxRequest) inbox.value = result
  } catch {
    if (request !== inboxRequest) return
    inbox.value = null
    message.value = 'Could not load the local inbox.'
  }
}

async function subscribe() {
  if (!consent.value || busy.value) return
  busy.value = true
  try {
    await $fetch('/api/newsletter/subscribe', {
      method: 'POST',
      body: {
        email: email.value,
        consent: true,
        consentVersion: 'basic-v1'
      }
    })
    message.value = 'Request accepted. Refresh the local inbox to see any confirmation mail.'
    await refreshInbox()
  } catch {
    message.value = 'Could not submit your request. Please try again.'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <main>
    <h1>Newsletter signup</h1>
    <p>This local example has one default audience and sends no real mail.</p>
    <form @submit.prevent="subscribe">
      <label>Email <input v-model="email" type="email" required autocomplete="email"></label>
      <label>
        <input v-model="consent" type="checkbox" required>
        I agree to receive the newsletter (consent version basic-v1).
      </label>
      <button :disabled="busy" type="submit">Request confirmation</button>
    </form>
    <p role="status">{{ message }}</p>

    <section>
      <h2>Local development inbox</h2>
      <p>For local testing only: this inbox reveals bearer links and subscription status for the entered address.</p>
      <button :disabled="busy || !email.trim()" type="button" @click="refreshInbox">Refresh inbox</button>
      <template v-if="inbox">
        <p>Subscription: {{ inbox.status ?? 'none' }}</p>
        <template v-if="inbox.mail">
          <h3>{{ inbox.mail.subject }}</h3>
          <pre>{{ inbox.mail.text }}</pre>
          <a :href="inbox.mail.confirmationUrl" target="_blank" rel="noopener noreferrer">Open confirmation page</a>
        </template>
        <p v-if="inbox.unsubscribeUrl">
          <a :href="inbox.unsubscribeUrl" target="_blank" rel="noopener noreferrer">Open unsubscribe page</a>
        </p>
      </template>
    </section>
  </main>
</template>

<style scoped>
main { max-width: 42rem; margin: 3rem auto; padding: 0 1rem; font: 1rem/1.5 system-ui, sans-serif; }
form label { display: block; margin: 1rem 0; }
button { margin: .5rem 0; padding: .5rem; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
