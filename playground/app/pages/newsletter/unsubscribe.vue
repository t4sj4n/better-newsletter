<script setup lang="ts">
const route = useRoute()
const capability = computed(() => typeof route.query.capability === 'string' ? route.query.capability : '')
const all = computed(() => route.query.all === '1')
const completed = ref(false)
const message = ref('')
const busy = ref(false)

useHead({ meta: [{ name: 'referrer', content: 'no-referrer' }] })

async function unsubscribe() {
  if (!capability.value || busy.value) return
  busy.value = true
  try {
    const result = await $fetch<{ unsubscribed: boolean }>(
      all.value ? '/api/newsletter/unsubscribe-all' : '/api/newsletter/unsubscribe',
      { method: 'POST', body: { capability: capability.value } }
    )
    completed.value = true
    message.value = result.unsubscribed
      ? all.value
        ? 'Unsubscribed from all audiences. You can close this tab and return to the demo.'
        : 'Unsubscribed from this audience. You can close this tab and return to the demo.'
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
    <h1>{{ all ? 'Unsubscribe from all newsletters' : 'Unsubscribe from a newsletter' }}</h1>
    <p>Opening this page does not change preferences. Only the button sends a POST request.</p>
    <p v-if="!capability">The unsubscribe link is missing a capability.</p>
    <button v-else-if="!completed" :disabled="busy" @click="unsubscribe">
      {{ all ? 'Unsubscribe from all' : 'Unsubscribe from this audience' }}
    </button>
    <p role="status">{{ message }}</p>
    <NuxtLink to="/">Open demo in this tab</NuxtLink>
  </main>
</template>

<style scoped>
main { max-width: 40rem; margin: 3rem auto; font: 1rem/1.5 system-ui, sans-serif; }
</style>
