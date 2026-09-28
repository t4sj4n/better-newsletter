<script setup lang="ts">
type Inbox = {
  contactStatus: string | null
  subject: { namespace: string, id: string } | null
  subscriptions: { audience: string, status: string }[]
  confirmationLinks: {
    audience: string
    expiresAt: string
    lastDeliveredAt: string
    acceptedDeliveries: number
    url: string
  }[]
  unsubscribeLinks: { audience: string, url: string }[]
  unsubscribeAllUrl: string | null
  preferencesUrl: string | null
}

const email = ref('')
const consent = ref(false)
const website = ref('')
const selectedAudiences = ref(['default'])
const retryAudience = ref('default')
const failure = ref<'TEMPORARY' | 'AMBIGUOUS'>('TEMPORARY')
const inbox = ref<Inbox | null>(null)
const message = ref('')
const busy = ref(false)
const audiences = ['default', 'product-news', 'weekly-analysis']
const retrySubscription = computed(() =>
  inbox.value?.subscriptions.find(subscription => subscription.audience === retryAudience.value) ?? null
)
const canRetryDelivery = computed(() =>
  retrySubscription.value?.status === 'PENDING_CONFIRMATION'
)

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Request failed.'
}

async function refreshInbox() {
  if (!email.value.trim()) return
  try {
    inbox.value = await $fetch<Inbox>('/api/demo/inbox', {
      query: { email: email.value.trim() }
    })
  } catch (error) {
    message.value = errorMessage(error)
  }
}

async function subscribe() {
  if (!consent.value || selectedAudiences.value.length === 0) {
    message.value = 'Choose at least one audience and explicitly consent first.'
    return
  }
  busy.value = true
  try {
    await $fetch('/api/newsletter/subscribe', {
      method: 'POST',
      body: {
        email: email.value,
        audiences: selectedAudiences.value,
        consent: true,
        consentVersion: 'demo-privacy-v1',
        website: website.value
      }
    })
    message.value = 'Request accepted. Refresh the development inbox for confirmation links.'
    await refreshInbox()
  } catch (error) {
    message.value = errorMessage(error)
  } finally {
    busy.value = false
  }
}

async function resend() {
  busy.value = true
  try {
    await $fetch('/api/newsletter/resend-confirmation', {
      method: 'POST',
      body: { email: email.value, audience: retryAudience.value }
    })
    await refreshInbox()
    message.value = `Resend requested for ${retryAudience.value}. The accepted-delivery count and timestamp below update when a new fake mail is delivered.`
  } catch (error) {
    message.value = errorMessage(error)
  } finally {
    busy.value = false
  }
}

async function failNext() {
  busy.value = true
  try {
    await $fetch('/api/demo/fail-next', {
      method: 'POST',
      body: { email: email.value, audience: retryAudience.value, failure: failure.value }
    })
    message.value = `The next ${retryAudience.value} delivery will simulate ${failure.value}.`
  } catch (error) {
    message.value = errorMessage(error)
  } finally {
    busy.value = false
  }
}

async function advanceClock(milliseconds: number) {
  busy.value = true
  try {
    await $fetch('/api/demo/advance-clock', { method: 'POST', body: { milliseconds } })
    message.value = 'Demo clock advanced. Refresh the inbox, then retry or visit an older confirmation link.'
  } catch (error) {
    message.value = errorMessage(error)
  } finally {
    busy.value = false
  }
}

async function linkSubject() {
  busy.value = true
  try {
    await $fetch('/api/demo/link-subject', { method: 'POST' })
    email.value = 'demo-member@example.com'
    await refreshInbox()
    message.value = 'Linked the fixed server-owned mock member; no consent was created by linking.'
  } catch (error) {
    message.value = errorMessage(error)
  } finally {
    busy.value = false
  }
}

async function setSuppression(suppressed: boolean) {
  busy.value = true
  try {
    await $fetch('/api/demo/suppression', {
      method: 'POST',
      body: { email: email.value, suppressed }
    })
    await refreshInbox()
    message.value = 'Contact status changed; audience consent remains unchanged.'
  } catch (error) {
    message.value = errorMessage(error)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <main>
    <h1>Better Newsletter · Nuxt demo</h1>
    <p>Anonymous signup with explicit consent. No database, mail key, or real email delivery.</p>

    <section>
      <h2>Subscribe</h2>
      <form @submit.prevent="subscribe">
        <label>Email <input v-model="email" type="email" required autocomplete="email"></label>
        <fieldset>
          <legend>Audiences</legend>
          <label v-for="audience in audiences" :key="audience">
            <input v-model="selectedAudiences" type="checkbox" :value="audience">
            {{ audience }}
          </label>
        </fieldset>
        <label><input v-model="consent" type="checkbox" required> I agree to receive these newsletters (demo privacy version v1).</label>
        <div class="trap" aria-hidden="true">
          <label>Leave this field blank <input v-model="website" type="text" name="website" tabindex="-1" autocomplete="off"></label>
        </div>
        <button :disabled="busy" type="submit">Request confirmation</button>
      </form>
    </section>

    <section>
      <h2>Resend and delivery retry</h2>
      <label>Audience
        <select v-model="retryAudience">
          <option v-for="audience in audiences" :key="audience" :value="audience">{{ audience }}</option>
        </select>
      </label>
      <button :disabled="busy || !email || !canRetryDelivery" @click="resend">Resend confirmation</button>
      <p>
        Selected audience status:
        <strong>{{ retrySubscription?.status ?? 'not subscribed' }}</strong>.
        Resend is only applicable while the subscription is pending confirmation.
      </p>
      <p>For a retry test: arm a failure, subscribe or resend, then resend again. An ambiguous result holds its lease until the demo clock advances 11 seconds.</p>
      <label>Next mail attempt
        <select v-model="failure">
          <option value="TEMPORARY">Temporary failure (retry immediately)</option>
          <option value="AMBIGUOUS">Interrupted/ambiguous delivery (wait for lease)</option>
        </select>
      </label>
      <button :disabled="busy || !email || !canRetryDelivery" @click="failNext">Fail next delivery</button>
      <button :disabled="busy" @click="advanceClock(11_000)">Advance clock 11 seconds</button>
      <p>To test expiry, open a confirmation link <em>after</em> advancing the demo clock six minutes.</p>
      <button :disabled="busy" @click="advanceClock(6 * 60_000)">Advance clock six minutes</button>
    </section>

    <section>
      <h2>Trusted server operations (development only)</h2>
      <p>The mock member has a fixed identity on the server. Sign up <code>demo-member@example.com</code> first; linking a subject never creates consent. Real apps must verify an authenticated session server-side.</p>
      <button :disabled="busy" @click="linkSubject">Link fixed mock member</button>
      <p>Suppression applies to the Contact, not to any audience's consent. These demo-only controls are unavailable in production.</p>
      <button :disabled="busy || !email" @click="setSuppression(true)">Suppress contact</button>
      <button :disabled="busy || !email" @click="setSuppression(false)">Unsuppress contact</button>
    </section>

    <section>
      <h2>Development inbox</h2>
      <p>The following development-only endpoint exposes links for local testing. Never publish an inbox like this in production.</p>
      <button :disabled="busy || !email" @click="refreshInbox">Refresh inbox</button>
      <p role="status">{{ message }}</p>
      <template v-if="inbox">
        <p>Contact: {{ inbox.contactStatus ?? 'not found' }} · Subject: {{ inbox.subject ? `${inbox.subject.namespace}/${inbox.subject.id}` : 'none' }}</p>
        <ul>
          <li v-for="subscription in inbox.subscriptions" :key="subscription.audience">
            {{ subscription.audience }}: {{ subscription.status }}
          </li>
        </ul>
        <h3>Latest accepted confirmation mail per audience</h3>
        <ul>
          <li v-for="link in inbox.confirmationLinks" :key="link.audience">
            {{ link.audience }} · accepted deliveries: {{ link.acceptedDeliveries }}
            · last delivered: {{ link.lastDeliveredAt }}
            · expires: {{ link.expiresAt }} ·
            <a :href="link.url" target="_blank" rel="noopener noreferrer">Open confirmation landing page</a>
          </li>
        </ul>
        <h3>Capability links</h3>
        <ul>
          <li v-for="link in inbox.unsubscribeLinks" :key="link.audience">
            <a :href="link.url" target="_blank" rel="noopener noreferrer">Open {{ link.audience }} unsubscribe landing page</a>
          </li>
          <li v-if="inbox.unsubscribeAllUrl">
            <a :href="inbox.unsubscribeAllUrl" target="_blank" rel="noopener noreferrer">Open unsubscribe-all landing page</a>
          </li>
          <li v-if="inbox.preferencesUrl">
            <a :href="inbox.preferencesUrl" target="_blank" rel="noopener noreferrer">Open capability-authorized preferences landing page</a>
          </li>
        </ul>
      </template>
    </section>
  </main>
</template>

<style scoped>
main { max-width: 55rem; margin: 2rem auto; padding: 0 1rem; font: 1rem/1.5 system-ui, sans-serif; }
section { border-top: 1px solid #aaa; margin-top: 2rem; padding-top: 1rem; }
fieldset { margin: 1rem 0; }
fieldset label { display: block; }
button { margin: .4rem .5rem .4rem 0; padding: .5rem; }
input, select { margin: .4rem; }
.trap { position: absolute; left: -9999px; }
</style>
