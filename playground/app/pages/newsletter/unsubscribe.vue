<script setup lang="ts">
const route = useRoute()
const client = useNewsletterClient()
const all = computed(() => route.query.all === '1')

const { token, state, resultTitle, unsubscribe: unsubscribeSingle } = useNewsletterUnsubscribe({
  client: {
    unsubscribe: (cap: string) => all.value ? client.unsubscribeAll(cap) : client.unsubscribe(cap)
  }
})

const completed = computed(() => state.value === 'success')

useHead({ meta: [{ name: 'referrer', content: 'no-referrer' }] })
</script>

<template>
  <main>
    <h1>{{ all ? 'Unsubscribe from all newsletters' : 'Unsubscribe from a newsletter' }}</h1>
    <p>Opening this page does not change preferences. Only the button sends a POST request.</p>
    <p v-if="!token">The unsubscribe link is missing a capability.</p>
    <button v-else-if="!completed" :disabled="state === 'loading'" @click="() => unsubscribeSingle()">
      {{ all ? 'Unsubscribe from all' : 'Unsubscribe from this audience' }}
    </button>
    <p v-if="state !== 'idle'" role="status">{{ resultTitle }}</p>
    <NuxtLink to="/">Open demo in this tab</NuxtLink>
  </main>
</template>

<style scoped>
main { max-width: 40rem; margin: 3rem auto; font: 1rem/1.5 system-ui, sans-serif; }
</style>
