<script setup lang="ts">
const route = useRoute()
const capability = computed(() => typeof route.query.capability === 'string' ? route.query.capability : '')
const completed = ref(false)
const message = ref('')
const busy = ref(false)

useHead({ meta: [{ name: 'referrer', content: 'no-referrer' }] })
if (import.meta.server) {
  useResponseHeader('Cache-Control').value = 'no-store'
  useResponseHeader('Referrer-Policy').value = 'no-referrer'
}

async function unsubscribe() {
  if (!capability.value || busy.value) return
  busy.value = true
  try {
    const result = await $fetch<{ unsubscribed: boolean }>('/api/newsletter/unsubscribe', {
      method: 'POST',
      body: { capability: capability.value }
    })
    completed.value = true
    message.value = result.unsubscribed
      ? 'Unsubscribed. You can close this tab and return to the inbox.'
      : 'This link is invalid or outdated.'
  } catch {
    message.value = 'Unsubscribe failed. Please try again later.'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <main>
    <h1>Unsubscribe</h1>
    <p>Visiting this page does not unsubscribe. Pressing the button sends a POST request.</p>
    <p v-if="!capability">The unsubscribe link is missing a capability.</p>
    <button v-else-if="!completed" :disabled="busy" @click="unsubscribe">Unsubscribe</button>
    <p role="status">{{ message }}</p>
    <NuxtLink to="/">Open inbox in this tab</NuxtLink>
  </main>
</template>

<style scoped>
main { max-width: 42rem; margin: 3rem auto; font: 1rem/1.5 system-ui, sans-serif; }
</style>
