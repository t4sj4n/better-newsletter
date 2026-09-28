<script setup lang="ts">
const route = useRoute()
const token = computed(() => typeof route.query.token === 'string' ? route.query.token : '')
const completed = ref(false)
const message = ref('')
const busy = ref(false)

useHead({ meta: [{ name: 'referrer', content: 'no-referrer' }] })
if (import.meta.server) {
  useResponseHeader('Cache-Control').value = 'no-store'
  useResponseHeader('Referrer-Policy').value = 'no-referrer'
}

async function confirm() {
  if (!token.value || busy.value) return
  busy.value = true
  try {
    const result = await $fetch<{ confirmed: boolean }>('/api/newsletter/confirm', {
      method: 'POST',
      body: { token: token.value }
    })
    completed.value = true
    message.value = result.confirmed
      ? 'Subscription active. Return to the inbox to see its status.'
      : 'This link is invalid, used, or expired.'
  } catch {
    message.value = 'Confirmation failed. Please try again later.'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <main>
    <h1>Confirm subscription</h1>
    <p>Visiting this page does not confirm anything. Pressing the button sends a POST request.</p>
    <p v-if="!token">The confirmation link is missing a token.</p>
    <button v-else-if="!completed" :disabled="busy" @click="confirm">Confirm subscription</button>
    <p role="status">{{ message }}</p>
    <NuxtLink to="/">Back to inbox</NuxtLink>
  </main>
</template>

<style scoped>
main { max-width: 42rem; margin: 3rem auto; font: 1rem/1.5 system-ui, sans-serif; }
</style>
