<script setup lang="ts">
const route = useRoute()
const token = computed(() => typeof route.query.token === 'string' ? route.query.token : '')
const completed = ref(false)
const message = ref('')
const busy = ref(false)

useHead({ meta: [{ name: 'referrer', content: 'no-referrer' }] })

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
      ? 'Subscription confirmed.'
      : 'This link is invalid, already used, or expired. Request a new confirmation.'
  } catch {
    message.value = 'Confirmation failed. Please try again later.'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <main>
    <h1>Confirm newsletter subscription</h1>
    <p>Opening this page never confirms a subscription. Only the button sends a POST request.</p>
    <p v-if="!token">The confirmation link is missing a token.</p>
    <button v-else-if="!completed" :disabled="busy" @click="confirm">Confirm subscription</button>
    <p role="status">{{ message }}</p>
    <NuxtLink to="/">Back to demo</NuxtLink>
  </main>
</template>

<style scoped>
main { max-width: 40rem; margin: 3rem auto; font: 1rem/1.5 system-ui, sans-serif; }
</style>
