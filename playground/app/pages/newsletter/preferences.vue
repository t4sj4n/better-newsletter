<script setup lang="ts">
type Subscription = { audience: string, status: string, unsubscribeCapability: string }

const client = useNewsletterClient()
const route = useRoute()
const capability = computed(() => typeof route.query.capability === 'string' ? route.query.capability : '')
const subscriptions = ref<Subscription[] | null>(null)
const completed = ref(false)
const message = ref('')
const busy = ref(false)

useHead({ meta: [{ name: 'referrer', content: 'no-referrer' }] })

async function viewPreferences() {
  if (!capability.value || busy.value) return
  busy.value = true
  try {
    const result = await client.preferences(capability.value)
    completed.value = true
    subscriptions.value = result.subscriptions as Subscription[] | null
    message.value = result.subscriptions == null
      ? 'This preferences link is invalid or outdated.'
      : 'Current audience subscriptions are shown below. You can close this tab when finished and return to the demo.'
  } catch {
    message.value = 'Unable to load preferences. Please try again later.'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <main>
    <h1>Newsletter preferences</h1>
    <p>Opening this page does not read private subscription details or change consent. Press the button to make a capability-authorized, read-only POST.</p>
    <p v-if="!capability">The preferences link is missing a capability.</p>
    <button v-else-if="!completed" :disabled="busy" @click="viewPreferences">View subscriptions</button>
    <p role="status">{{ message }}</p>
    <ul v-if="subscriptions">
      <li v-for="subscription in subscriptions" :key="subscription.audience">
        {{ subscription.audience }}: {{ subscription.status }}
      </li>
    </ul>
    <NuxtLink to="/">Open demo in this tab</NuxtLink>
  </main>
</template>

<style scoped>
main { max-width: 40rem; margin: 3rem auto; font: 1rem/1.5 system-ui, sans-serif; }
</style>
