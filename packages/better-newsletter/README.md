# better-newsletter

Framework-agnostic newsletter subscription and consent lifecycle infrastructure for TypeScript.

> **Status:** early development. The core lifecycle, PostgreSQL persistence, Resend confirmation delivery, and Nuxt/Nitro adapter are available.

## Scope

`better-newsletter` provides reusable newsletter lifecycle primitives without becoming a campaign platform:

- explicit newsletter consent;
- Double Opt-In lifecycle;
- per-audience subscription state;
- global delivery suppression;
- append-only lifecycle evidence;
- trusted migration/import of known historical consent;
- provider-neutral storage, delivery and capability contracts;
- optional linking to an application-owned subject.

It is **not** a campaign editor, CRM, marketing automation suite, authentication library, analytics product, or segmentation/query engine.

## Contact and subscription model

A Contact is the delivery identity. A Subscription is the consent state for one audience.

```text
Contact: person@example.com
status: ENABLED
subject: optional opaque application reference
        |
        +-- default          ACTIVE
        +-- product-news     UNSUBSCRIBED
        +-- weekly-analysis  PENDING_CONFIRMATION
```

This distinction is intentional:

- bounce/complaint/manual suppression belongs to the **Contact**;
- consent, confirmation and unsubscribe belong to a **Subscription**;
- one e-mail address can have multiple independent subscriptions;
- suppression blocks delivery without rewriting historical consent state.

V1 uses opaque `audienceKey` strings rather than a list-management subsystem. Single-newsletter applications can use the built-in `default` audience.

## Core lifecycle

```text
new explicit consent
  -> PENDING_CONFIRMATION
  -> confirmation
  -> ACTIVE
  -> unsubscribe
  -> UNSUBSCRIBED
  -> new explicit consent
  -> PENDING_CONFIRMATION
```

A globally suppressed Contact cannot be confirmed or receive a confirmation message until a trusted caller deliberately unsuppresses it.

Repeated public signup is neutral and idempotent:

- pending subscriptions are not duplicated or silently given new consent evidence;
- active subscriptions are not downgraded or re-confirmed;
- unsubscribed subscriptions require fresh consent and a fresh DOI cycle;
- suppressed Contacts remain suppressed.

Use the dedicated `resendConfirmation()` operation when a new confirmation message is needed. Abuse throttling and confirmation-token replacement are handled by the security and lifecycle configuration described below.

### Trusted administrative confirmation links

Authenticated server code can create a confirmation link without sending mail:

```ts
const input = { subscription: { id: subscriptionId } }
const state = await newsletter.getConfirmationState(input)
if (state?.canCreate) {
  const result = await newsletter.createConfirmationToken(input)
  if (result) {
    const url = new URL('/newsletter/confirm', applicationOrigin)
    url.searchParams.set('token', result.token)
    // Display the link only to an authorized administrator.
  }
}
```

Both operations also accept `subscription: { email, audience? }`. These are trusted server-only APIs: the host must authorize access to the subscription and decide where links are displayed. Do not expose them through anonymous routes. In a host-owned authenticated Nuxt server route, obtain the same service with `const newsletter = await useBetterNewsletter(event)` from `better-newsletter/nuxt/server`. The module does not register administrative routes or expose these operations in its browser client.

`createConfirmationToken()` returns `{ token, expiresAt }`, or `null` when the subscription does not exist, is ACTIVE or UNSUBSCRIBED, or its Contact is globally suppressed. It rechecks eligibility transactionally, uses the configured token generator, persists the digest through the configured capabilities, binds the current lifecycle generation, and applies `confirmation.expiresInMs`, `replacementStrategy` and `maxActiveTokens` exactly as mail delivery does. It appends `CONFIRMATION_TOKEN_CREATED` and any replacement/expiry events atomically. The raw token is returned only to the caller. This operation sends no mail and does not complete or cancel queued confirmation delivery; subsequent signup/resend delivery can replace the token according to the same configured strategy.

Trusted callers can optionally attach host-specific audit data to the `CONFIRMATION_TOKEN_CREATED` event:

```ts
const result = await newsletter.createConfirmationToken({
  subscription: { id: subscriptionId },
  eventMetadata: {
    actorId: session.user.id
  }
})
```

`eventMetadata` accepts JSON values and is optional. Better Newsletter does not interpret its contents or use them for authorization, eligibility, expiry, replacement or any other lifecycle decision. Host metadata is merged first; authoritative Better Newsletter fields such as `audienceKey` and `lifecycleGeneration` are set afterwards and cannot be overwritten. Metadata belongs only to the token-created audit event, not replacement or expiry events. `getConfirmationState()` accepts only the subscription lookup and does not need audit metadata.

`getConfirmationState()` returns `null` for a missing subscription, otherwise `{ canCreate, reason, activeTokenExpiresAt }`. `reason` is `null` when eligible, or `ACTIVE`, `UNSUBSCRIBED` or `SUPPRESSED` (suppression takes precedence). The expiry is the latest expiry among unconsumed, unrevoked, unexpired confirmation tokens in the current lifecycle, or `null` when none are usable or confirmation is blocked. No digests or storage records are returned. This is a snapshot; token creation always rechecks eligibility and confirmation always rechecks the lifecycle.


## Creating a service

The lifecycle is framework- and provider-neutral. Storage, delivery and capability behavior are injected:

```ts
import { betterNewsletter } from 'better-newsletter'

const newsletter = betterNewsletter({
  storage,
  mailer,
  capabilities,
  confirmation: {
    expiresInMs: 24 * 60 * 60 * 1000
  }
})
```

Time, IDs, and confirmation-token generation can be injected for deterministic tests. When no token generator is supplied, the core uses a Web Crypto generator that produces 32 random bytes. The public configuration and service types are `BetterNewsletterOptions` and `BetterNewsletter`. The service exposes lifecycle operations only; storage, mailer, signing capabilities, clocks, and generators are injected dependencies, not properties of the returned service. The browser helper remains `createNewsletterClient()` from `better-newsletter/nuxt/client`.

The runtime and the development CLI are separate packages. The runtime is embedded in your application; the CLI runs only when explicitly invoked:

| Import | Purpose |
| --- | --- |
| `better-newsletter` | Service factory, public lifecycle/domain types and errors. |
| `better-newsletter/adapters/memory` | In-memory storage and test helpers. |
| `better-newsletter/adapters/postgres` | PostgreSQL storage, migrations, rate limiting and recipient selection. |
| `better-newsletter/mailers` | Provider-neutral mailer and delivery contracts. |
| `better-newsletter/mailers/resend` | Resend mail delivery. |
| `better-newsletter/webhooks/resend` | Verified Resend delivery feedback; requires the optional `resend` peer. |
| `better-newsletter/security` | Capability and abuse-protection implementation contracts and helpers. |
| `better-newsletter/storage` | Storage and transaction contracts for custom adapters. |
| `better-newsletter/db/migration` | Programmatic database migration API. |
| `better-newsletter/nuxt`, `/nuxt/server`, `/nuxt/client` | Nuxt module, Nitro server helpers and browser client. |
| `@better-newsletter/cli` | Explicit `better-newsletter` migration executable. |

Both packages maintain synchronized versions. The runtime is released before the CLI at the same version; the CLI declares an exact runtime dependency to avoid mismatched migration tooling.

## Production security

The security layer is framework- and database-neutral:

```ts
import { betterNewsletter } from 'better-newsletter'
import { createSecureCapabilities } from 'better-newsletter/security'

const capabilities = createSecureCapabilities({
  secrets: [
    { version: 2, value: process.env.NEWSLETTER_LINK_SECRET_V2! },
    { version: 1, value: process.env.NEWSLETTER_LINK_SECRET_V1! }
  ]
})

const newsletter = betterNewsletter({
  storage,
  mailer,
  capabilities
})
```

The host supplies the lifecycle storage contract. Each storage transaction exposes a `confirmationTokens: ConfirmationTokenStore`, and the capabilities receive that store for every confirmation operation. Token replacement, consumption and revocation therefore commit or roll back together with lifecycle state and events. No unsubscribe nonce store is needed. The PostgreSQL adapter provides durable storage for this contract.

Security properties:

- confirmation tokens use 32 bytes of Web Crypto entropy by default;
- only SHA-256 confirmation-token digests are persisted;
- confirmation consumption is single-use and must be atomic in the token store;
- confirmation links are scoped to a Subscription ID and its persisted lifecycle generation;
- unsubscribe links are HMAC-SHA-256 signed and purpose-bound;
- unsubscribe capabilities contain no e-mail address;
- signed target IDs and generations remove mutable nonce initialization and issuance races;
- per-audience unsubscribe and unsubscribe-all use distinct purposes;
- re-subscription atomically increments subscription and contact generations, invalidating old capabilities even when their resolution was already in flight;
- expired, consumed, and revoked confirmation records can be removed through explicit cleanup.

Use at least 32 bytes for every HMAC secret. `createSecureCapabilities()` and `createHmacRateLimitKeyProvider()` throw `INVALID_CONFIGURATION` synchronously for missing or weak secrets. For new deployments, configure `secrets` alone. Its first entry signs new `bn3` links; remaining entries verify previously issued `bn3` links. Versions are unique non-negative integer identifiers, not ordering guarantees, and may have gaps. The version is signed into each link and selects its verification key directly. Better Newsletter does not persist signing secrets; keep them stable and available to every service instance.

For deployments with existing `bn2` links, use a staged rollout. First configure both `hmacSecret` and `secrets` with `issueLegacyCapabilities: true`: upgraded instances keep issuing `bn2` while verifying both formats, so old `bn2`-only instances can still serve. Once every serving instance can verify `bn3`, remove `issueLegacyCapabilities` to issue `bn3`. Keep `hmacSecret` to verify existing `bn2` links. For later `bn3` rotations, first add the new version after the current entry everywhere; then make it first everywhere. Signed unsubscribe and manage-preferences links have no expiry field. Removing `hmacSecret` or an older version deliberately invalidates otherwise valid links signed with it; retain keys until that compatibility decision is acceptable. Lifecycle-generation changes revoke links independently of key rotation. New deployments should configure `secrets` alone.

### Lifecycle generations and adapter requirements

`Subscription.lifecycleGeneration` and `Contact.capabilityGeneration` start at `1` and are positive safe integers. A re-subscription increments both in the same transaction that records fresh consent and queues confirmation work. Adding a new audience to an existing Contact, through signup or trusted import, increments `capabilityGeneration`. Repeated pending or active signups do not increment either generation or rewrite consent.

Confirmation and per-audience unsubscribe targets carry `lifecycleGeneration`; unsubscribe-all targets carry `capabilityGeneration`. The core compares the resolved generation with the current persisted row **inside the state-transition transaction**. Resolving or verifying a signed capability alone is not authorization: a previously signed target may belong to an old generation.

Contact-wide generation changes invalidate previous unsubscribe-all links whenever any audience starts a new consent cycle. Per-audience generations keep other audiences independent. Repeated unsubscribe requests remain idempotent until a new cycle starts.

Storage adapters must serialize conflicting contact-wide and subscription operations, including generation checks, generation increments, confirmation-delivery claims, token-store writes, state updates, and event appends. Roll them back together. Either run transactions with SERIALIZABLE isolation or lock every contact and subscription row read inside a transaction (for example `SELECT ... FOR UPDATE`). The core always reads the contact before its subscriptions, and subscriptions before locking token records; `ConfirmationTokenStore.resolve()` is a non-locking read. `listEvents()` returns events in append order.

Adapters report unique-constraint violations, serialization failures, and deadlocks as `StorageConflictError`. The core then re-runs the whole transaction callback, up to `transactionMaxAttempts` (default `3`). Callbacks have no side effects outside the transaction, so re-running them is safe. For example, two concurrent first signups for the same address both succeed: the losing insert is retried and observes the other Contact. IDs must never be reused, and generations must never be reset on existing rows. Injected ID generators must produce unique IDs across service instances.

`ConfirmationTokenStore.replace()` must atomically enforce replacement and bounded retention within `(subscriptionId, lifecycleGeneration)`, retaining the newest records first and breaking timestamp ties by insertion order. Revocation is also generation-scoped, so it cannot revoke a new cycle's tokens. Confirmation resolves, checks, and consumes the token inside the activation transaction, so a rolled-back activation does not burn its token. Unsubscribe, unsubscribe-all, and suppression revoke pending confirmation tokens in the same transaction.

These are breaking pre-release contract changes: adapters must persist both generation fields, `Subscription.confirmationDelivery`, and the generation on confirmation-token records. The nonce-store API and legacy opaque unsubscribe replacement hooks have been removed. Existing `bn1` links are not accepted; generation-bound links use `bn2` with singular `hmacSecret` or `bn3` with versioned `secrets`.

### Scanner-safe web flows

Core methods are mutation methods. Framework integrations should use a safe landing page and an explicit mutation:

```text
GET link
  -> render confirmation/unsubscribe page
  -> POST/action
  -> confirm() or unsubscribe()
```

Do not confirm or unsubscribe merely because an e-mail security scanner or link preview performed a GET. An application may deliberately implement a browser-side auto-POST confirmation flow, but it is not the library default.

### Cleanup

Token expiry and physical deletion are separate. Expired tokens become invalid immediately; cleanup is explicit and scheduler-neutral:

```ts
await newsletter.cleanupConfirmationTokens({
  retentionMs: 7 * 24 * 60 * 60 * 1000
})
```

Call this from the scheduler appropriate to the host runtime.

## Abuse protection

`subscribe()` and `resendConfirmation()` support a generic `AbuseGuard` plus provider-neutral rate limiting:

```ts
import {
  createHmacRateLimitKeyProvider
} from 'better-newsletter/security'

const newsletter = betterNewsletter({
  storage,
  mailer,
  capabilities,
  abuseGuard,
  rateLimiter,
  rateLimitKeyProvider: createHmacRateLimitKeyProvider({
    secret: process.env.NEWSLETTER_RATE_LIMIT_SECRET!
  })
})
```

The built-in HMAC key provider derives opaque 64-character keys instead of passing raw e-mail addresses to the rate limiter. A framework adapter may supply trusted request context and a custom material function for an IP/fingerprint-based policy.

A rejected request throws `NewsletterError` with code `RATE_LIMITED` and, when the limiter reports it, `retryAfterMs` for a `Retry-After` response header.

Rate limiting is intentionally not represented by a silent production no-op. If a `rateLimiter` is configured, a `rateLimitKeyProvider` is required as well. Signup and resend use separate action buckets and policies.

The generic abuse guard can integrate a honeypot, Cloudflare Turnstile, hCaptcha, ALTCHA, WAF/session proof, or another host-owned mechanism without coupling the core to that provider.

## Subscribe and confirm

Public signup requires an explicit consent signal and version:

```ts
await newsletter.subscribe({
  email: 'person@example.com',
  audience: 'default',
  consent: {
    granted: true,
    version: 'privacy-2026-09',
    source: 'landing-page',
    locale: 'de'
  }
})
```

The public result is deliberately neutral:

```ts
{ accepted: true }
```

It does not reveal whether the address is unknown, pending, active, unsubscribed or suppressed. Confirmation delivery runs asynchronously; signup acceptance does not wait for mail delivery.

Confirmation is capability-based:

```ts
await newsletter.confirm({ token })
```

Production confirmation capabilities are provided by `createSecureCapabilities()`. Raw confirmation tokens are never persisted by that implementation: only SHA-256 digests are passed to the token store. Tokens are purpose-bound, subscription-bound, expiring, and atomically consumable through the store contract.

The default resend policy retains at most the immediately previous still-valid confirmation token (`maxActiveTokens: 2`) to tolerate ambiguous mail-provider timeouts without allowing an unbounded set of live links. Applications may instead choose `REPLACE_PREVIOUS`.

### Retrying unfinished confirmation work

Signup persists a `confirmationDelivery` work item together with pending consent, before starting asynchronous processing. Its stable `id`, unique `attemptId`, and `leaseExpiresAt` let independent service instances claim work transactionally without an in-process lock. Concurrent signups reuse the pending work rather than starting duplicate live attempts.

The mailer receives the `deliveryId` of the work item, the current `attemptId`, the `audienceKey`, and the `lifecycleGeneration`, next to the Contact, the claimed Subscription and the token. `deliveryId` stays stable across retries of the same work and suits correlation. Every attempt carries a fresh token, so use `attemptId` as a provider idempotency key.

Accepted delivery atomically sets `confirmationSentAt`, clears the work item, and appends its delivery event. A mailer reports a failed send as `{ accepted: false, failure }`:

- `TEMPORARY` (the default for explicit failures without a category, and for token setup failures): the claim is released for an immediate retry.
- `PERMANENT`: the work item is dropped; a later `subscribe()` does not retry it, while `resendConfirmation()` starts new work.
- `AMBIGUOUS` (also used when delivery throws): the provider may have sent the message. The claim is kept until its lease expires, so an immediate retry cannot add another message. The retry after expiry is a new attempt of the same work item.

Each failure records `CONFIRMATION_SEND_FAILED` with its `outcome` and `stage`. Optional `reason` is limited to the `MAIL_DELIVERY_REASONS` codes from `better-newsletter/mailers` (`INVALID_REQUEST`, `AUTH_FAILED`, `RATE_LIMITED`, `PROVIDER_UNAVAILABLE`, `TIMEOUT`, `RENDER_FAILED`, `TOKEN_SETUP_FAILED`, `UNKNOWN`); unexpected values are persisted as `UNKNOWN`, never as raw provider text. If the Contact was suppressed after the claim, the claim is released and the event records stage `ELIGIBILITY`. Failures do not discard possibly delivered tokens; the configured bounded retention policy still applies. A subsequent `subscribe()` or `resendConfirmation()` resumes unfinished work without replacing consent or incrementing generations.

Delivery result events carry `deliveryId`, `attemptId`, `lifecycleGeneration`, `authoritative`, and `outcome` (`ACCEPTED`, `TEMPORARY`, `PERMANENT`, or `AMBIGUOUS`). `CONFIRMATION_SENT` and `CONFIRMATION_SEND_FAILED` always mean `authoritative: true`: the result belongs to the attempt that currently owns the work and was allowed to finalize it. A result from a superseded attempt is recorded as `CONFIRMATION_STALE_RESULT` with `authoritative: false` and never changes Subscription state. An attempt is superseded when its lease was reclaimed by a newer attempt, or when the work ended in the meantime (confirmation, unsubscribe, or a new lifecycle generation).

If a process stops or result persistence fails, the work remains recoverable after its lease expires. Configure `confirmation.deliveryLeaseMs` for the expected provider timeout; it defaults to five minutes. A later attempt gets a new attempt ID. Token replacement runs under the lifecycle transaction's ownership check; completion also checks ownership, so an older worker cannot replace newer tokens, clear newer work, or modify a new consent cycle. Capability adapters must support being called from lifecycle transactions without re-entering the same lifecycle locks. Delivery events identify the lifecycle generation and attempt.

Delivery is **at least once**, not exactly once: an ambiguous provider result or expired lease can lead to another message. The core does not run a scheduler or automatically drain pending work after restart. Hosts must keep asynchronous processing alive or trigger retry through signup/resend.

### Resend confirmation delivery

On Node.js 20.11 or newer, create a **server-only** API key and verify the sender domain in the [Resend dashboard](https://resend.com/domains). The `/mailers/resend` export is optional: core-only users do not install or configure Resend. The default adapter uses the documented HTTPS `POST /emails` API through the runtime's `fetch`, so no Resend SDK is required; callers who already use the Resend SDK can inject their own SDK instance as `client` instead of providing `apiKey`. Keep the API key in server-side environment variables; do not put it in a client bundle.

```ts
import { betterNewsletter } from 'better-newsletter'
import { createSecureCapabilities } from 'better-newsletter/security'
import { resendMailer } from 'better-newsletter/mailers/resend'

const mailer = resendMailer({
  apiKey: process.env.RESEND_API_KEY!,
  from: 'Newsletter <news@example.com>', // use a verified sender domain
  replyTo: 'support@example.com',
  renderConfirmation: async input => {
    const url = new URL('/newsletter/confirm', process.env.PUBLIC_APP_ORIGIN!)
    url.searchParams.set('token', input.token)
    return {
      subject: `Confirm ${input.audienceKey} updates`,
      html: `<p><a href="${url.toString()}">Confirm subscription</a></p>`,
      text: `Confirm your subscription: ${url.toString()}`
    }
  }
})

const newsletter = betterNewsletter({
  storage,
  mailer,
  capabilities: createSecureCapabilities({
    secrets: [{ version: 1, value: process.env.NEWSLETTER_LINK_SECRET! }]
  })
})
```

The renderer receives the Contact and Subscription (including locale, consent source and metadata), audience key, token, expiry, stable delivery ID, attempt ID and lifecycle generation. It owns all copy and the confirmation URL; the adapter never infers a hostname from request headers. Supply exactly one of `apiKey` or a compatible `client`; `fetch` may be injected for custom transport or tests. The default transport never logs provider response bodies (the standalone Resend SDK may log API errors in non-production environments when you inject it). Resend handles email transport only; local Contact/Subscription state and consent evidence remain authoritative. This mailer does not send campaigns; delivery feedback uses the separate webhook adapter below.

Resend receives a SHA-256 idempotency key derived from the stable work ID, *individual attempt* ID and lifecycle generation, not from the recipient, body or bearer token. Replaying the **same attempt with the same payload** can be deduplicated by Resend for [up to 24 hours](https://resend.com/docs/dashboard/emails/idempotency-keys). New leased attempts carry new tokens and new keys, so Resend cannot guarantee exactly-once delivery across attempts. A 409 for an in-flight idempotent request, a generic 5xx or an unknown transport outcome is `AMBIGUOUS`: the core holds the claim until its lease expires instead of starting a new attempt immediately. A new attempt after lease expiry still uses a fresh key; the adapter cannot promise cross-attempt deduplication. Known API-key errors map to `AUTH_FAILED`; other 403 responses, including sender-domain validation failures, map to `INVALID_REQUEST`. Provider rejection is never recorded as an accepted send. The adapter emits only bounded failure codes and does not log API keys, tokens or rendered bodies or persist provider payloads. The host remains responsible for its privacy policy and provider agreement.

### Delivery feedback and Resend webhooks

The trusted `processFeedback()` service method accepts normalized provider feedback. Complaints, permanent bounces, and provider suppression suppress the Contact by default. Transient bounces are recorded only; set `feedbackPolicy.softBounceThreshold` to suppress after a chosen number of distinct soft bounces. `feedbackPolicy.suppressOnComplaint`, `suppressOnHardBounce`, and `suppressOnProviderSuppression` can disable the respective default action. A delivered event never unsuppresses a Contact. Subscription consent and status remain unchanged. Provider event IDs are claimed in the same storage transaction as the feedback and suppression events; custom storage adapters must implement `claimProviderEvent()` atomically. Feedback at or before the latest trusted `UNSUPPRESSED` timestamp remains in the audit trail but cannot suppress or count toward the new soft-bounce window. Audit events record processing time in `occurredAt` and provider time in `metadata.feedbackOccurredAt`. Adapters must implement `latestUnsuppressedAt()` and `countSoftBouncesAfter()` without loading full history into the core; PostgreSQL indexes both lookups.

Install `resend` alongside the optional webhook subpath, configure a Resend webhook signing secret, and register `email.bounced`, `email.complained`, `email.suppressed`, `email.delivered`, and optionally `suppression.added` with Resend. Pass the **raw** body and Svix headers to the handler:

```ts
import { resendWebhook } from 'better-newsletter/webhooks/resend'

const handleFeedback = resendWebhook({
  newsletter,
  webhookSecret: process.env.RESEND_WEBHOOK_SECRET!
})

// In a server-only POST route:
const result = await handleFeedback({
  payload: await request.text(),
  headers: Object.fromEntries(request.headers)
})
```

The handler verifies Resend's signature before parsing or changing state. It returns `processed: false` for duplicate or unrelated events. Invalid signatures yield a bounded `INVALID_WEBHOOK` error without returning the raw body or signing secret. Only the provider, event ID, feedback type and timestamp are stored; raw webhook bodies and provider messages are discarded. Resend bounce types other than `Permanent` are treated as soft bounces. An unknown recipient is not created automatically and can be retried after the Contact exists.

At the core level, `subscribe()` and `resendConfirmation()` enqueue confirmation delivery and normally answer before it finishes, so delivery errors do not reveal whether an address has pending work. Pass `runBackground` to hand the work to the runtime, for example to `event.waitUntil()` on serverless platforms. The tasks it receives never reject. Background failures are reported through `logger.error` (default: `console`); failures of the synchronous state transition propagate to the caller. The Nuxt server helper handles runtimes without `waitUntil` differently, as described below.

```ts
const newsletter = betterNewsletter({
  storage,
  mailer,
  capabilities,
  runBackground: task => event.waitUntil(task),
  logger
})
```

When adapting a runtime without `waitUntil`, collect background tasks and **await them before the request ends** (or move delivery to a durable worker). Simply starting a floating Promise is not reliable when a serverless worker can terminate at response time. This can extend response time, but the public response must still be neutral. The core does not schedule retries after a restart; retry unfinished work through a later signup/resend or your own scheduler.

## Unsubscribe and preferences

Create an unsubscribe capability from trusted application code and pass only that opaque value to the public action:

```ts
const capability = await newsletter.createUnsubscribeCapability({
  email: 'person@example.com',
  audience: 'product-news'
})

await newsletter.unsubscribe({ capability })
```

A separate capability can authorize explicit unsubscribe-all behavior:

```ts
const capability = await newsletter.createUnsubscribeCapability({
  email: 'person@example.com',
  all: true
})

await newsletter.unsubscribeAll({ capability })
```

Unsubscribe changes Subscription consent state. It does **not** globally suppress the Contact.

A distinct, purpose-bound capability lets a trusted server expose only public audience keys and statuses through a read-only preferences POST:

```ts
const capability = await newsletter.createManagePreferencesCapability({
  email: 'person@example.com'
})
const subscriptions = capability == null
  ? null
  : await newsletter.listPreferences({ capability })
// [{ audience: 'default', status: 'ACTIVE', unsubscribeCapability: '...' }, ...]
// or null for an invalid/stale link
```

Do not issue this capability from a public email-only endpoint. Render a safe GET landing page, then submit the capability by POST to fetch preferences. Listing does not change consent or expose the Contact email or subject. The result includes per-audience unsubscribe capabilities: treat those as bearer credentials, not public display data.

## External application subjects

A Contact may optionally link to an application-owned entity:

```ts
await newsletter.linkSubject({
  email: 'person@example.com',
  subject: {
    namespace: 'app-user',
    id: '550e8400-e29b-41d4-a716-446655440000'
  }
})
```

The reference is opaque. `better-newsletter` does not query, own, or require the host application's user table. Linking never creates consent or changes Subscription status. Replacing a different existing subject requires the trusted `replace: true` option.

## Suppression

Global operational suppression is explicit and independent from newsletter consent:

```ts
await newsletter.suppressContact({
  email: 'person@example.com',
  reason: 'BOUNCE'
})
```

The shared delivery eligibility rule remains:

```text
Contact.status == ENABLED
AND Subscription.status == ACTIVE
AND confirmedAt is present
AND unsubscribedAt is absent
```

A deliberate trusted `unsuppressContact()` operation re-enables the Contact but does not reactivate or rewrite any Subscription.

## Privacy export and erasure

Call these methods only from authenticated, trusted server code. `exportContactData({ email })` or `exportContactData({ id })` returns the Contact profile and subject link, its Subscriptions and consent evidence, lifecycle events, suppression fields, and confirmation-token **metadata**. It omits token digests and raw tokens. The export can still contain personal data deliberately placed in Contact or event metadata; protect the resulting object and review host-supplied metadata before storing it.

```ts
const data = await newsletter.exportContactData({ email: 'person@example.com' })

await newsletter.eraseContactData({
  contact: { email: 'person@example.com' },
  strategy: 'DELETE',
  suppression: 'RETAIN_HASH'
})
```

`DELETE` removes the Contact, its subject link, Subscriptions, tokens, provider-event IDs and lifecycle events in one transaction. `ANONYMIZE` keeps an inert Contact and minimized event rows: it replaces the e-mail with a random placeholder, clears the subject and metadata, removes confirmation tokens and provider-event IDs, clears event metadata, replaces audience keys and consent text, unsubscribes every Subscription, and advances capability generations. Repeating the same operation returns `{ erased: false }`; an anonymized Contact can later be deleted by ID. Ordinary public unsubscribe preserves consent and event history; it never calls erasure.

The host chooses suppression retention per erasure call. Omit `suppression` (or use `NONE`) for full erasure. `RETAIN_HASH` stores only a keyed HMAC digest in `newsletter_suppression_keys`, with no Contact link, and future public signups for that e-mail are accepted without creating a Contact. Configure a stable, private key provider first:

```ts
import { createHmacSuppressionKeyProvider } from 'better-newsletter/security'

const newsletter = betterNewsletter({
  // storage, mailer, capabilities, ...
  suppressionKeyProvider: createHmacSuppressionKeyProvider({
    secrets: [
      { version: 2, value: process.env.NEWSLETTER_SUPPRESSION_SECRET_V2! },
      { version: 1, value: process.env.NEWSLETTER_SUPPRESSION_SECRET_V1! }
    ]
  })
})
```

Each secret must contain at least 32 bytes and be shared across instances. The first entry derives new retained hashes; older entries allow signup checks and trusted removal to find earlier hashes. An existing singular `secret` configuration remains supported. A v1-only retained hash cannot be recomputed with v2 after erasure because the address is no longer stored. Keep v1 configured while those entries must remain effective, or migrate them using an independent address source before retiring it. Removing v1 makes v1-only suppression ineffective. Keep secrets outside the database. A plain SHA-256 e-mail hash is vulnerable to address guessing; use a keyed digest. Hosts can instead retain no local suppression key and use their own external suppression store. The library makes no legal retention decision. The host decides whether evidence must remain, whether suppression is needed, and how any external store or backup is handled. Anonymization retains internal IDs and timestamps, so use opaque generated IDs and choose `DELETE` when those fields could identify a person.

`unsuppressContact()` re-enables an existing Contact. To reverse post-erasure `RETAIN_HASH`, call the trusted `removeRetainedSuppression({ email })` service method. It normalizes the address, removes every matching digest from the configured key ring in one transaction, returns `{ removed: boolean }`, and does not recreate the Contact. Do not expose this trusted method as a public-by-email endpoint.

## Trusted import

Existing applications can migrate known historical consent without manufacturing a new DOI:

```ts
await newsletter.importSubscription({
  email: 'legacy@example.com',
  audience: 'default',
  status: 'ACTIVE',
  consent: {
    version: 'legacy-v1',
    consentedAt: new Date('2025-01-01T00:00:00Z')
  },
  confirmedAt: new Date('2025-01-01T00:05:00Z')
})
```

Import is a trusted service operation, not a public signup path. Importing `ACTIVE` requires an explicit `confirmedAt` and no `unsubscribedAt`; the library never invents confirmation evidence. Repeating the same import is idempotent, while conflicting historical facts are rejected.

## Lifecycle events

Meaningful transitions append lifecycle evidence such as:

```text
SIGNED_UP
RESUBSCRIBED
CONFIRMATION_REQUESTED
CONFIRMATION_SENT
CONFIRMATION_SEND_FAILED
CONFIRMATION_STALE_RESULT
CONFIRMED
UNSUBSCRIBED
SUPPRESSED
UNSUPPRESSED
SUBJECT_LINKED
IMPORTED
```

Current Contact and Subscription rows remain the operational source of truth. The event contract is append-only; it is not an event-sourcing requirement.

## Memory adapters

For tests and development:

```ts
import {
  memoryCapabilities,
  memoryAdapter
} from 'better-newsletter/adapters/memory'
```

`memoryAdapter()` serializes conflicting in-process transactions so lifecycle concurrency can be tested deterministically.

`memoryCapabilities()` uses the real hashing/HMAC implementation with an ephemeral signing key. Confirmation digests live in `memoryAdapter()` and roll back with its transactions; `confirmationTokenSnapshot()` exposes the committed records for assertions. For distributed-style tests, combine separate `createSecureCapabilities()` instances with the same signing key and one shared `memoryAdapter()`. The memory storage reports duplicate inserts as `StorageConflictError`. None of the memory stores are durable production persistence.

Production storage must provide transaction semantics strong enough to serialize conflicting contact-wide and subscription transitions, including generation checks and delivery claims. The PostgreSQL adapter enforces database uniqueness and atomicity.

## PostgreSQL

The PostgreSQL adapter targets PostgreSQL 14 or newer, Kysely 0.28.17 through 0.29.x, `pg` 8.x, and Node.js 20.11 or newer. It is implemented with Kysely but supports PostgreSQL specifically; the public adapter does not imply compatibility with other Kysely dialects. If you use the optional `/adapters/postgres` subpath, install a supported Kysely version and a PostgreSQL driver in your application (for example, `pnpm add kysely@^0.28.17 pg@^8`). Kysely is an optional peer dependency; `pg` is only a development dependency of this package. Core-only consumers do not need either. Kysely 0.29 requires Node.js 22 or newer and TypeScript 5.4 or newer. Provide your own configured Kysely database instance and connection pool; the library does not own their lifecycle.

### Database migrations

Better Newsletter never creates or alters database objects during normal application startup. Configure a migration provider next to your server configuration and choose either the direct or host-managed workflow:

```ts
// server/better-newsletter.config.ts
import { defineBetterNewsletterMigrationConfig } from 'better-newsletter/db/migration'
import {
  postgresMigration,
  postgresAdapter
} from 'better-newsletter/adapters/postgres'

const db = createApplicationDatabase()

export const migration = defineBetterNewsletterMigrationConfig({
  provider: postgresMigration(db),
  // Optional but useful for CLI processes that own this database client.
  close: () => db.destroy()
})

export default defineBetterNewsletterConfig(async () => ({
  origin,
  storage: postgresAdapter(db),
  capabilities,
  mailer
}))
```

Install the migration CLI separately as a development/deployment tool:

```bash
pnpm add -D @better-newsletter/cli
```

The CLI discovers `better-newsletter.config.ts` or `server/better-newsletter.config.ts` by default. Use `--config <path>` for another TypeScript/JavaScript config file. It reads the named `migration` export and does not invoke the runtime newsletter factory, so mail providers and signing secrets are not needed merely to inspect the schema. Keep `better-newsletter` installed in the application that owns this config.

For direct schema management:

```bash
pnpm exec better-newsletter migrate
# non-interactive deployment:
pnpm exec better-newsletter migrate --yes
```

`migrate` inspects the live database, prints the required additive plan, asks for confirmation, and applies the whole PostgreSQL plan transactionally. Direct PostgreSQL migrations take a schema-scoped advisory lock and recheck the approved plan before applying: if another migration has already brought the schema current, they finish without changes; if the schema changed in another way, they stop so you can review a new plan.

For applications that own migration history:

```bash
pnpm exec better-newsletter generate --output ./migrations/better-newsletter.sql
```

For a one-off invocation without a locally installed CLI, run `npx --package=@better-newsletter/cli better-newsletter migrate` (or `generate`). The runtime must still be installed in the application whose configuration is loaded.

`generate` inspects the same live database but only writes the required SQL. Review/check that SQL into the host migration system and apply it with the host's normal deployment ordering. Existing compatible objects are not recreated and unrelated host tables/columns are left untouched. Destructive or data-transforming future upgrades are not inferred from a schema diff; they require an explicit reviewed Better Newsletter upgrade step.

### Host-owned migration history

Choose `migrate` when Better Newsletter should apply schema changes directly. Choose `generate` when your application already owns migration history, including applications using Kysely's `Migrator`.

1. Generate SQL using the installed package and a development database at the intended starting state. An empty newsletter schema produces the complete initial schema; an existing schema produces only the required additions.
2. Inspect the SQL, including its target PostgreSQL schema, and commit it as a new, immutable migration in your host's migration system.
3. Apply that static SQL using the host's normal migration runner and deployment ordering. Replaying the migration must not depend on the currently installed Better Newsletter version.
4. After a package upgrade that requires schema changes, generate against a database with the previous host migrations applied. Review and commit the resulting SQL as a **new** host migration. Leave historical migrations unchanged.

Do not call `postgresMigration(db).plan()` / `provider.apply(plan)` or `getMigrations(...).runMigrations()` from a historical host migration: the plan follows the installed package's current target schema, so replaying the same historical migration could produce different SQL after an upgrade. There is no additional Better Newsletter integration required for the host's migration runner; execute the reviewed static SQL through that runner.

For direct schema management outside a historical host migration, the same engine is available programmatically:

```ts
import { getMigrations } from 'better-newsletter/db/migration'

const migrations = await getMigrations(migration)
console.log(migrations.toBeCreated, migrations.toBeAdded)
await migrations.runMigrations()
```

`packages/better-newsletter/migrations/postgres/001_newsletter.sql` remains an inspectable generated snapshot of the current empty-database target, not the primary installation/upgrade API and not an independent schema source. `pnpm migration:snapshot:check` verifies it against the canonical schema model; contributors update the model first and regenerate the snapshot with `pnpm migration:snapshot:write`.

```ts
import { betterNewsletter } from 'better-newsletter'
import { createHmacRateLimitKeyProvider } from 'better-newsletter/security'
import {
  postgresRateLimiter,
  postgresAdapter,
  listEligibleSubscriptions
} from 'better-newsletter/adapters/postgres'

// db is the host application's configured Kysely instance for PostgreSQL.
const newsletter = betterNewsletter({
  storage: postgresAdapter(db),
  mailer,
  capabilities,
  rateLimiter: postgresRateLimiter(db),
  rateLimitKeyProvider: createHmacRateLimitKeyProvider({
    secret: process.env.NEWSLETTER_RATE_LIMIT_SECRET!
  })
})

const recipients = await listEligibleSubscriptions(db, 'default')
```

`listEligibleSubscriptions()` is a read-only recipient-selection helper for one audience. It selects only enabled Contacts with active, confirmed, not-unsubscribed Subscriptions. Re-check eligibility when sending if recipient state may have changed since selection; no campaign sending or scheduler is provided. Hosts that need another database or storage design can implement `NewsletterStorage` and `RateLimiter` directly.

The migration defines `newsletter_contacts`, `newsletter_subscriptions`, `newsletter_tokens`, `newsletter_events`, `newsletter_provider_events`, `newsletter_suppression_keys`, and `newsletter_rate_limits`. Contact, Subscription, and event IDs are application-generated `text` values: the core generates UUIDs by default, but injected generators may produce other unique strings. `email` must already be trimmed and lowercase and is globally unique; `(contact_id, audience_key)` is unique. Each Contact can link at most one external subject per newsletter instance through opaque `subject_namespace` and `subject_id` strings without a foreign key into the host application; the core controls replacement of an existing subject. Contact metadata and event metadata are JSON objects in `jsonb`; event types use the `event_type` text column. Subscription consent evidence is stored in `consent_version`, `consent_source`, `consent_locale`, and `consented_at`. Delivery work is stored in `confirmation_delivery_id`, `confirmation_attempt_id`, and `confirmation_lease_expires_at`. Both generation columns are positive `bigint` values and must remain within JavaScript's safe-integer range when mapped to the core.

Only confirmation-token digests, never raw confirmation tokens, belong in `newsletter_tokens`. Its identity `id` orders equal-timestamp records deterministically for bounded retention within `(subscription_id, lifecycle_generation)`; `sequence` gives events append order even when timestamps match. Store `capabilityGeneration` and `lifecycleGeneration` persistently; do not reset generations or reuse IDs. All state transitions, token mutations, and event appends must share one atomic transaction. Serialize conflicting transitions with `SERIALIZABLE` isolation or row locks, taking contact locks before subscription locks and token locks. Retry unique violations, serialization failures, and deadlocks through the storage conflict contract rather than continuing a failed transaction.

`newsletter_rate_limits` is an optional SQL fixed-window counter keyed by `(key_hash, action, window_ms, bucket_start_ms)`, with `attempt_count` and `expires_at`; including the window length prevents different configured policies from sharing a bucket. `postgresRateLimiter(db)` performs atomic consumption across service instances and accepts any string returned by your `RateLimitKeyProvider` (including base64url HMACs); despite the `key_hash` column name, it stores the provided key as-is. Always supply a privacy-preserving opaque key rather than raw e-mail or IP data. Rate-limit counters and expired token rows need explicit scheduled cleanup; neither import nor the core starts a scheduler. Keep HMAC signing and rate-limit secrets stable across process restarts and protect them outside the database. Rotating a signing secret invalidates outstanding unsubscribe links; rotating the rate-limit secret resets effective buckets.

Deleting a Contact cascades to its Subscriptions, token records, provider-event claims, and lifecycle events. Events are otherwise append-only; the schema does not use an immutable-event trigger that would block deliberate privacy minimization or erasure. The suppression-key table has no Contact foreign key so a chosen hash can survive deletion; the host owns its retention and removal policy.

## Nuxt 4 / Nitro

Install the package in a Nuxt 4 application:

```bash
pnpm add better-newsletter
```

```ts
// nuxt.config.ts
import BetterNewsletter from 'better-newsletter/nuxt'

export default defineNuxtConfig({
  modules: [BetterNewsletter],
  betterNewsletter: {
    defaultAudience: 'default',
    consent: { version: 'privacy-2026-09', source: 'landing-page' },
    audiences: {
      default: { public: true },
      'product-news': { public: true },
      'weekly-analysis': { public: true }
    }
  }
})
```

The default `server/better-newsletter.config.ts` is a **server-only** configuration factory; `useBetterNewsletter(event)` is a server-only Promise-returning accessor for trusted handlers. The factory returns an application-owned `origin`, storage, mailer and capabilities. Do not import either from browser code. Keep long-lived adapters (database pool or memory storage) outside the factory instead of recreating them on every request. The Nuxt helper automatically uses the platform's `waitUntil` when available; otherwise its `subscribe()` and `resendConfirmation()` Promises await pending delivery work before resolving. Custom handlers do **not** need to call `flushBetterNewsletter()` after awaiting either method; an awaited fallback can increase response time without changing the neutral result.

```ts
// server/better-newsletter.config.ts
import { memoryCapabilities, memoryAdapter } from 'better-newsletter/adapters/memory'
import { defineBetterNewsletterConfig } from 'better-newsletter/nuxt/server'

const storage = memoryAdapter()
const capabilities = memoryCapabilities()
const appOrigin = new URL(process.env.APP_ORIGIN ?? 'http://localhost:3000').origin

export default defineBetterNewsletterConfig(async () => ({
  origin: appOrigin,
  storage,
  capabilities,
  mailer: {
    async sendConfirmation(input) {
      // Implement server-side delivery using a link to
      // new URL(`/newsletter/confirm?token=${encodeURIComponent(input.token)}`, appOrigin).
      // Never log or persist raw tokens; see playground/ for a local-only inbox.
      return { accepted: false, failure: 'TEMPORARY' }
    }
  }
}))
```

This placeholder mailer deliberately does **not** deliver. Replace it with a production mailer before accepting real subscriptions. Configure `APP_ORIGIN` to your application's trusted, fixed public origin; never construct confirmation links from an arbitrary request `Host` or forwarded host header. Server-only `newsletterUrl(appOrigin, '/newsletter/confirm', token)` from `better-newsletter/nuxt/server` constructs a confirmation landing-page URL with a URL-encoded token.

### Module options and public routes

| Option | Meaning |
| --- | --- |
| `defaultAudience` | Audience used when none is supplied (default: `default`). |
| `audiences` | Map of audience keys to `{ public: boolean }`. Only explicitly public audiences should be accepted by public endpoints. |
| `consent` | Version and source stored with explicit public consent (defaults: `{ version: 'v1', source: 'signup-form' }`). |
| `configFile` | Server config path, default `server/better-newsletter.config.ts`. |
| `routes` | Override a POST route path with a string or disable it with `false`. |

The built-in lifecycle actions and authorized preferences read are **POST only**:

| Route | Request body |
| --- | --- |
| `/api/newsletter/subscribe` | `{ email, audience?, audiences?, consent: true, consentVersion: string, website?: string }` (`website` is a honeypot) |
| `/api/newsletter/resend-confirmation` | `{ email, audience? }` |
| `/api/newsletter/confirm` | `{ token }` |
| `/api/newsletter/unsubscribe` | `{ capability }` |
| `/api/newsletter/unsubscribe-all` | `{ capability }` |
| `/api/newsletter/preferences` | `{ capability }` (read-only; returns `{ subscriptions: { audience, status, unsubscribeCapability }[] \| null }`) |

For example, `routes: { resendConfirmation: '/api/mail/resend', preferences: false }` moves one endpoint and omits another. The route keys are `subscribe`, `resendConfirmation`, `confirm`, `unsubscribe`, `unsubscribeAll` and `preferences`. If you disable a route, implement its POST behavior yourself or omit that UI feature. Do not put secrets, storage, or provider credentials in `nuxt.config.ts` public runtime config or browser bundles.

#### Custom public routes

Use the built-in public routes when their request validation and response format suit your application. If you need host-specific source validation, a honeypot, error translation or response semantics, implement a thin public server handler that calls `await useBetterNewsletter(event)` and then the appropriate service method with validated input.

When replacing public signup, disable the built-in endpoint:

```ts
// Inside defineNuxtConfig({ ... })
betterNewsletter: {
  routes: {
    subscribe: false
  }
}
```

Otherwise callers can still reach `/api/newsletter/subscribe` and bypass checks that exist only in your custom endpoint. Changing a built-in route's path only relocates the built-in handler; it does not attach your wrapper's validation. The same replacement rule applies to `resendConfirmation`, `confirm`, `unsubscribe`, `unsubscribeAll` and `preferences`. Point your client at the host endpoint and disable each corresponding built-in route you replace.

The custom handler owns the public HTTP boundary: validate and bound the request body, restrict public audiences, verify explicit consent and its configured version, validate or assign a trusted source, handle honeypots and supply any request-specific `securityContext` needed by your configured abuse guard. The module's built-in handler validation is not automatically run by `useBetterNewsletter(event)`. Configured service-level lifecycle checks, abuse guards and rate limits still apply; the Nuxt accessor also retains its configured client-identity rate limiting and delivery handling. Preserve neutral signup/resend responses and explicit POST actions for capability flows. Authorize administrative operations in the host; do not expose trusted lookup or token-creation methods through an anonymous wrapper.

#### Public flow responsibilities

The module supplies API endpoints, **not** consent forms, mail copy, confirmation pages, unsubscribe/preferences pages, or authentication. Build your own UI. GET confirmation/unsubscribe links should render landing pages with explicit POST buttons; GET preferences pages should likewise make no authorized read until an explicit POST. Never issue unsubscribe or preferences capabilities to an anonymous caller based solely on an email address. Generate links in trusted server code (for example, after authenticating the user or while sending their mail).

Public signup is anonymous and requires explicit versioned consent: the UI must obtain consent before POSTing `consent: true` and the `consentVersion` configured in `nuxt.config.ts`. The module uses the trusted configured source; it does not trust a source, locale, or subject in public JSON. Do not trust a claimed user ID from query parameters or headers. Use `await useBetterNewsletter(event)` in a protected server handler and call `linkSubject()` only after your application's **verified** session has supplied the identity; linking does not create consent. Likewise, `suppressContact`, `unsuppressContact`, imports and unsubscribe-capability issuance are trusted server operations, not public-by-email endpoints.

Protect subscribe and resend with the optional `website` honeypot or `abuseGuard` and production rate limiting. Plan separate limits for action, audience, normalized address and trusted client IP/network (plus global budgets); a single per-address limit cannot stop many-address abuse. Resolve proxy IPs only through configured, trusted infrastructure and use HMAC-derived opaque keys rather than raw address/IP in rate-limit storage. The core accepts `rateLimiter`, `rateLimitKeyProvider` and `rateLimits`; the Nuxt factory can supply these alongside its mailer and storage. For an additional client-identity dimension, configure both `trustedClientIdentity(event)` (from verified infrastructure, not arbitrary forwarded headers) and `clientRateLimit: { secret, limiter, policies? }` in the server factory.

The server-only config can also map untrusted request metadata into `securityContext(event, body)` for subscribe and resend. For example, add these properties to the object returned by `defineBetterNewsletterConfig` (where `verifyCaptchaToken` is your app's server-side CAPTCHA verifier):

```ts
securityContext: (_event, body) => ({
  captchaToken: typeof body.captchaToken === 'string' ? body.captchaToken : null
}),
abuseGuard: {
  async verify({ context }) {
    const token = (context as { captchaToken?: unknown } | undefined)?.captchaToken
    return { allowed: typeof token === 'string' && await verifyCaptchaToken(token) }
  }
}
```

The handler passes this transient context to the core `abuseGuard` and `rateLimitKeyProvider`; it does not itself persist raw IPs or CAPTCHA tokens. Never trust a client-supplied IP or session claim in `body`. If you add a trusted network identity from `event`, hash/HMAC it before writing any rate-limit key; do not include raw IPs or CAPTCHA tokens in contact metadata, events or logs.

For production, replace memory adapters with `postgresAdapter(db)` and `postgresRateLimiter(db)` from `better-newsletter/adapters/postgres`, configure `postgresMigration(db)`, and apply the schema with `better-newsletter migrate` or your host-managed `generate` workflow, `createSecureCapabilities({ secrets: [{ version: 1, value: signingSecret }] })`, `createHmacRateLimitKeyProvider({ secret })`, and `resendMailer({ apiKey, from, renderConfirmation })` from `better-newsletter/mailers/resend`. Configure a verified sender, durable PostgreSQL connection, stable server-side signing/rate-limit secrets, a trusted origin for URLs, and runtime-safe background delivery (`waitUntil`, an awaited fallback or a durable worker). See the adapter sections above for integration details; the example deliberately uses none of these external services.

### TypeScript and large Nitro route tables

Large applications can hit `TS2589` in Nitro's typed route matcher when a fetch request generic covers the entire route table. This can also happen without Better Newsletter. With the investigated Nuxt/Nitro signatures, narrow the request type at affected calls, especially when supplying an explicit response type:

```ts
import type { NuxtError } from '#app'

interface Item { id: string }

const { data } = await useFetch<Item[], NuxtError, '/api/items'>(
  '/api/items',
  { default: () => [] }
)
```

For `$fetch`, the request is its second generic: `$fetch<Response, '/api/items'>('/api/items')`. Use a suitable bounded request type for dynamic paths. Keep newsletter entries in generated `InternalApi` to retain route and method checking. The [#43 investigation](https://github.com/t4sj4n/better-newsletter/blob/main/docs/nuxt-route-types.md) contains the reproduction, TypeScript trace evidence and a packed-consumer test that retains all six module routes. This is a mitigation for upstream route matching; it does not guarantee that every large application will stay within TypeScript's limits.

### Consumer example and maintainer playground

To learn the essential Nuxt integration, start with [`examples/basic/`](https://github.com/t4sj4n/better-newsletter/tree/main/examples/basic) in the [consumer examples](https://github.com/t4sj4n/better-newsletter/tree/main/examples): a small, copyable signup, confirmation and unsubscribe flow. Contributors testing lifecycle edge cases should use [`playground/`](https://github.com/t4sj4n/better-newsletter/tree/main/playground), the full maintainer development app with three audiences, a fake inbox, preferences, suppression and delivery-failure/expiry controls. Both import only public package APIs and remain outside the npm artifact. From this repository checkout:

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm --dir examples/basic dev
```

To run the maintainer playground instead:

```bash
pnpm --dir playground dev
```

The root pnpm install also installs both consumers. After building the library, run `pnpm --dir examples/basic typecheck` and `pnpm --dir examples/basic build` to validate the small example, or `pnpm --dir playground typecheck` and `pnpm --dir playground build` to validate the full app. The basic example uses a pinned published package version for standalone consumption and StackBlitz.

For artifact-level smoke tests of both runtime and CLI in isolated consumers, run `node scripts/smoke-pack.mjs` after `pnpm build`. This checks packed `dist` exports rather than merely the source checkout.

## Development

This repository uses pnpm.

Repository layout:

| Path | Role |
| --- | --- |
| `packages/better-newsletter/` | Embedded runtime library, adapters, Nuxt integration and public subpaths. |
| `packages/cli/` | Separate migration/deployment CLI; depends on the runtime, never the reverse. |
| `playground/` | Full maintainer development/debugging Nuxt app, excluded from the npm artifact. |
| `examples/basic/` | Minimal, copyable consumer integration example, excluded from the npm artifact. |
| `test/` | Automated tests; `test/fixtures/` contains automated consumers, not documentation examples. |
| `packages/better-newsletter/migrations/` | Generated/verified database-specific schema snapshots shipped with the runtime package. |
| `packages/*/dist/` | Generated package output, not committed to Git. |

```bash
pnpm install --frozen-lockfile
pnpm check
```

Individual commands:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

The CLI's standalone typecheck resolves `better-newsletter/db/migration` from runtime source, so `pnpm check` also works in a fresh checkout without generated `dist/`. The CLI publish build clears that TypeScript path mapping and resolves the actual runtime package declarations after the runtime build. This keeps the checked import and the published dependency aligned.

Set `DATABASE_URL` to a disposable PostgreSQL database to run the integration
tests (the test user needs `CREATE SCHEMA`). The tests create and remove their
own isolated schema; without `DATABASE_URL`, they are skipped. CI provisions a
temporary PostgreSQL service and runs them on every check.

## License

MIT
