<script setup lang="ts">
const { token, state, completed, resultTitle, confirm } = useNewsletterConfirm()

useHead({ meta: [{ name: 'referrer', content: 'no-referrer' }] })
if (import.meta.server) {
  useResponseHeader('Cache-Control').value = 'no-store'
  useResponseHeader('Referrer-Policy').value = 'no-referrer'
}
</script>

<template>
  <main>
    <h1>Confirm subscription</h1>
    <p>Visiting this page does not confirm anything. Pressing the button sends a POST request.</p>
    <p v-if="!token">The confirmation link is missing a token.</p>
    <button v-else-if="!completed" :disabled="state === 'loading'" @click="confirm">Confirm subscription</button>
    <p v-if="state !== 'idle'" role="status">{{ resultTitle }}</p>
    <NuxtLink to="/">Open inbox in this tab</NuxtLink>
  </main>
</template>

<style scoped>
main { max-width: 42rem; margin: 3rem auto; font: 1rem/1.5 system-ui, sans-serif; }
</style>
