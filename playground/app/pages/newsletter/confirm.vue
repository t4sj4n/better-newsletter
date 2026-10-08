<script setup lang="ts">
const { token, state, completed, resultTitle, confirm } = useNewsletterConfirm()

useHead({ meta: [{ name: 'referrer', content: 'no-referrer' }] })
</script>

<template>
  <main>
    <h1>Confirm newsletter subscription</h1>
    <p>Opening this page never confirms a subscription. Only the button sends a POST request.</p>
    <p v-if="!token">The confirmation link is missing a token.</p>
    <button v-else-if="!completed" :disabled="state === 'loading'" @click="confirm">Confirm subscription</button>
    <p v-if="state !== 'idle'" role="status">{{ resultTitle }}</p>
    <NuxtLink to="/">Open demo in this tab</NuxtLink>
  </main>
</template>

<style scoped>
main { max-width: 40rem; margin: 3rem auto; font: 1rem/1.5 system-ui, sans-serif; }
</style>
