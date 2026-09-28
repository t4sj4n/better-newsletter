# better-newsletter

Framework-agnostic newsletter subscription and consent lifecycle infrastructure for TypeScript.

> **Status:** early development. The core lifecycle and production security primitives are implemented; persistent PostgreSQL and delivery/framework adapters follow in issues #4–#6.

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

Use the dedicated `resendConfirmation()` operation when a new confirmation message is needed. Abuse throttling and hardened token replacement semantics belong to #3.

## Creating a service

The lifecycle is framework- and provider-neutral. Storage, delivery and capability behavior are injected:

```ts
import { createNewsletter } from 'better-newsletter'

const newsletter = createNewsletter({
  storage,
  mailer,
  capabilities,
  confirmation: {
    expiresInMs: 24 * 60 * 60 * 1000
  }
})
```

Time, IDs, and confirmation-token generation can be injected for deterministic tests. When no token generator is supplied, the core uses a Web Crypto generator that produces 32 random bytes.

## Production security

The security layer is framework- and database-neutral:

```ts
import {
  createNewsletter,
  createSecureCapabilities
} from 'better-newsletter'

const capabilities = createSecureCapabilities({
  confirmationStore,
  hmacSecret: process.env.NEWSLETTER_LINK_SECRET!
})

const newsletter = createNewsletter({
  storage,
  mailer,
  capabilities
})
```

The host supplies persistence for `ConfirmationTokenStore` and the lifecycle storage contract. No unsubscribe nonce store is needed. Issue #4 will provide the PostgreSQL/Kysely implementation.

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

Use a secret with at least 32 bytes for HMAC signing.

### Lifecycle generations and adapter requirements

`Subscription.lifecycleGeneration` and `Contact.capabilityGeneration` start at `1` and are positive safe integers. A re-subscription increments both in the same transaction that records fresh consent and queues confirmation work. Repeated pending or active signups do not increment either generation or rewrite consent.

Confirmation and per-audience unsubscribe targets carry `lifecycleGeneration`; unsubscribe-all targets carry `capabilityGeneration`. The core compares the resolved generation with the current persisted row **inside the state-transition transaction**. Resolving or verifying a signed capability alone is not authorization: a previously signed target may belong to an old generation.

Contact-wide generation changes invalidate previous unsubscribe-all links whenever any audience starts a new consent cycle. Per-audience generations keep other audiences independent. Repeated unsubscribe requests remain idempotent until a new cycle starts.

Storage adapters must serialize conflicting contact-wide and subscription operations, including generation checks, generation increments, confirmation-delivery claims, state updates, and event appends. Roll them back together. IDs must never be reused, and generations must never be reset on existing rows. Injected ID generators must produce unique IDs across service instances.

`ConfirmationTokenStore.replace()` must atomically enforce replacement and bounded retention within `(subscriptionId, lifecycleGeneration)`, retaining the newest records first and breaking timestamp ties by insertion order. Revocation is also generation-scoped, so delayed old-generation cleanup cannot revoke a new cycle's tokens. Confirmation activation rechecks token validity inside lifecycle storage; token consumption follows a successful commit so a rolled-back activation does not burn its token.

These are breaking pre-release contract changes: adapters must persist both generation fields, `Subscription.confirmationDelivery`, and the generation on confirmation-token records. The nonce-store API and legacy opaque unsubscribe replacement hooks have been removed. Existing `bn1` links are not accepted; newly issued generation-bound links use `bn2`.

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

const newsletter = createNewsletter({
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

Accepted delivery atomically sets `confirmationSentAt`, clears the work item, and appends its delivery event. Token-setup errors, provider rejection, and ambiguous provider exceptions record `CONFIRMATION_SEND_FAILED` and release the claim for retry. They do not discard possibly delivered tokens; the configured bounded retention policy still applies. A subsequent `subscribe()` or `resendConfirmation()` resumes unfinished work without replacing consent or incrementing generations.

If a process stops or result persistence fails, the work remains recoverable after its lease expires. Configure `confirmation.deliveryLeaseMs` for the expected provider timeout; it defaults to five minutes. A later attempt gets a new attempt ID. Token replacement runs under the lifecycle transaction's ownership check; completion also checks ownership, so an older worker cannot replace newer tokens, clear newer work, or modify a new consent cycle. Capability adapters must support being called from lifecycle transactions without re-entering the same lifecycle locks. Delivery events identify the lifecycle generation and attempt.

Delivery is **at least once**, not exactly once: an ambiguous provider result or expired lease can lead to another message. The core does not run a scheduler or automatically drain pending work after restart. Hosts must keep asynchronous signup processing alive or trigger retry through signup/resend; `resendConfirmation()` awaits processing. Background persistence failures are reported through `console.error`; synchronous persistence failures propagate to the caller.

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

## External application subjects

A Contact may optionally link to an application-owned entity:

```ts
await newsletter.linkSubject({
  email: 'person@example.com',
  subject: {
    namespace: 'tipplabor-user',
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
  memoryStorage
} from 'better-newsletter/memory'
```

`memoryStorage()` serializes conflicting in-process transactions so lifecycle concurrency can be tested deterministically.

`memoryCapabilities()` uses the real hashing/HMAC implementation with an ephemeral signing key and in-memory confirmation digests. For distributed-style tests, combine separate `createSecureCapabilities()` instances with a shared `memoryConfirmationTokenStore()` and the same signing key. None of the memory stores are durable production persistence.

Production storage must provide transaction semantics strong enough to serialize conflicting contact-wide and subscription transitions, including generation checks and delivery claims. The PostgreSQL/Kysely adapter in #4 will enforce database uniqueness and atomicity.

## Development

This repository uses pnpm.

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

## Design references

### Tipplabor

Tipplabor is the primary behavioral reference. Its existing newsletter implementation already exercises real DOI, re-subscribe, neutral public responses, provider-send result recording, unsubscribe and concurrency edge cases:

- https://github.com/t4sj4n/tipplabor/issues/65
- https://github.com/t4sj4n/tipplabor/blob/staging/frontend/server/repositories/newsletter-opt-in-repository.ts
- https://github.com/t4sj4n/tipplabor/blob/staging/frontend/shared/utils/newsletter.ts

The goal is to generalize proven behavior and tests, **not** to copy Tipplabor-specific routes, tables, UI text, account models, launch logic or Cloudflare assumptions.

### listmonk

[listmonk](https://github.com/knadh/listmonk) is a non-normative architectural reference for separating subscriber-wide state from per-list subscription state and for preference-management edge cases.

listmonk is AGPLv3. This MIT project does **not** copy or port listmonk implementation code.

## Issue boundaries

Issue #2 implements the framework-neutral lifecycle and consent model. The following remain separate:

- #3: cryptographic token/capability security, abuse protection and cleanup (implemented here);
- #4: Kysely/PostgreSQL persistence;
- #5: Resend delivery adapter;
- #6: Nuxt/Nitro integration;
- #7: provider bounce/complaint feedback;
- #8: privacy export and erasure lifecycle.

## License

MIT
