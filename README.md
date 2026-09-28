# better-newsletter

Framework-agnostic newsletter subscription and consent lifecycle infrastructure for TypeScript.

> **Status:** early development. The core lifecycle, production security primitives, and PostgreSQL/Kysely persistence are implemented; delivery/framework adapters follow in issues #5–#6.

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
  hmacSecret: process.env.NEWSLETTER_LINK_SECRET!
})

const newsletter = createNewsletter({
  storage,
  mailer,
  capabilities
})
```

The host supplies the lifecycle storage contract. Each storage transaction exposes a `confirmationTokens: ConfirmationTokenStore`, and the capabilities receive that store for every confirmation operation. Token replacement, consumption and revocation therefore commit or roll back together with lifecycle state and events. No unsubscribe nonce store is needed. The PostgreSQL/Kysely adapter provides durable storage for this contract.

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

Use a secret with at least 32 bytes for HMAC signing. `createSecureCapabilities()` and `createHmacRateLimitKeyProvider()` throw `INVALID_CONFIGURATION` synchronously for a shorter or missing secret.

### Lifecycle generations and adapter requirements

`Subscription.lifecycleGeneration` and `Contact.capabilityGeneration` start at `1` and are positive safe integers. A re-subscription increments both in the same transaction that records fresh consent and queues confirmation work. Adding a new audience to an existing Contact, through signup or trusted import, increments `capabilityGeneration`. Repeated pending or active signups do not increment either generation or rewrite consent.

Confirmation and per-audience unsubscribe targets carry `lifecycleGeneration`; unsubscribe-all targets carry `capabilityGeneration`. The core compares the resolved generation with the current persisted row **inside the state-transition transaction**. Resolving or verifying a signed capability alone is not authorization: a previously signed target may belong to an old generation.

Contact-wide generation changes invalidate previous unsubscribe-all links whenever any audience starts a new consent cycle. Per-audience generations keep other audiences independent. Repeated unsubscribe requests remain idempotent until a new cycle starts.

Storage adapters must serialize conflicting contact-wide and subscription operations, including generation checks, generation increments, confirmation-delivery claims, token-store writes, state updates, and event appends. Roll them back together. Either run transactions with SERIALIZABLE isolation or lock every contact and subscription row read inside a transaction (for example `SELECT ... FOR UPDATE`). The core always reads the contact before its subscriptions, and subscriptions before locking token records; `ConfirmationTokenStore.resolve()` is a non-locking read. `listEvents()` returns events in append order.

Adapters report unique-constraint violations, serialization failures, and deadlocks as `StorageConflictError`. The core then re-runs the whole transaction callback, up to `transactionMaxAttempts` (default `3`). Callbacks have no side effects outside the transaction, so re-running them is safe. For example, two concurrent first signups for the same address both succeed: the losing insert is retried and observes the other Contact. IDs must never be reused, and generations must never be reset on existing rows. Injected ID generators must produce unique IDs across service instances.

`ConfirmationTokenStore.replace()` must atomically enforce replacement and bounded retention within `(subscriptionId, lifecycleGeneration)`, retaining the newest records first and breaking timestamp ties by insertion order. Revocation is also generation-scoped, so it cannot revoke a new cycle's tokens. Confirmation resolves, checks, and consumes the token inside the activation transaction, so a rolled-back activation does not burn its token. Unsubscribe, unsubscribe-all, and suppression revoke pending confirmation tokens in the same transaction.

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

- `TEMPORARY` (the default, also used when the mailer throws or token setup fails): the claim is released for an immediate retry.
- `PERMANENT`: the work item is dropped; a later `subscribe()` does not retry it, while `resendConfirmation()` starts new work.
- `AMBIGUOUS`: the provider may have sent the message. The claim is kept until its lease expires, so an immediate retry cannot add another message. The retry after expiry is a new attempt of the same work item.

Each failure records `CONFIRMATION_SEND_FAILED` with its `outcome` and `stage`. If the Contact was suppressed after the claim, the claim is released and the event records stage `ELIGIBILITY`. Failures do not discard possibly delivered tokens; the configured bounded retention policy still applies. A subsequent `subscribe()` or `resendConfirmation()` resumes unfinished work without replacing consent or incrementing generations.

Delivery result events carry `deliveryId`, `attemptId`, `lifecycleGeneration`, `authoritative`, and `outcome` (`ACCEPTED`, `TEMPORARY`, `PERMANENT`, or `AMBIGUOUS`). `CONFIRMATION_SENT` and `CONFIRMATION_SEND_FAILED` always mean `authoritative: true`: the result belongs to the attempt that currently owns the work and was allowed to finalize it. A result from a superseded attempt is recorded as `CONFIRMATION_STALE_RESULT` with `authoritative: false` and never changes Subscription state. An attempt is superseded when its lease was reclaimed by a newer attempt, or when the work ended in the meantime (confirmation, unsubscribe, or a new lifecycle generation).

If a process stops or result persistence fails, the work remains recoverable after its lease expires. Configure `confirmation.deliveryLeaseMs` for the expected provider timeout; it defaults to five minutes. A later attempt gets a new attempt ID. Token replacement runs under the lifecycle transaction's ownership check; completion also checks ownership, so an older worker cannot replace newer tokens, clear newer work, or modify a new consent cycle. Capability adapters must support being called from lifecycle transactions without re-entering the same lifecycle locks. Delivery events identify the lifecycle generation and attempt.

Delivery is **at least once**, not exactly once: an ambiguous provider result or expired lease can lead to another message. The core does not run a scheduler or automatically drain pending work after restart. Hosts must keep asynchronous processing alive or trigger retry through signup/resend.

Both `subscribe()` and `resendConfirmation()` answer before delivery finishes, so neither response time nor delivery errors reveal whether an address has pending work. Pass `runBackground` to hand the background work to the runtime, for example to `event.waitUntil()` on serverless platforms. The tasks it receives never reject. Background failures are reported through `logger.error` (default: `console`); failures of the synchronous state transition propagate to the caller.

```ts
const newsletter = createNewsletter({
  storage,
  mailer,
  capabilities,
  runBackground: task => event.waitUntil(task),
  logger
})
```

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
  memoryStorage
} from 'better-newsletter/memory'
```

`memoryStorage()` serializes conflicting in-process transactions so lifecycle concurrency can be tested deterministically.

`memoryCapabilities()` uses the real hashing/HMAC implementation with an ephemeral signing key. Confirmation digests live in `memoryStorage()` and roll back with its transactions; `confirmationTokenSnapshot()` exposes the committed records for assertions. For distributed-style tests, combine separate `createSecureCapabilities()` instances with the same signing key and one shared `memoryStorage()`. The memory storage reports duplicate inserts as `StorageConflictError`. None of the memory stores are durable production persistence.

Production storage must provide transaction semantics strong enough to serialize conflicting contact-wide and subscription transitions, including generation checks and delivery claims. The PostgreSQL/Kysely adapter enforces database uniqueness and atomicity.

## PostgreSQL / Kysely

The PostgreSQL adapter targets PostgreSQL 14 or newer, Kysely 0.28.x, `pg` 8.x, and Node.js 20.11 or newer. The package currently depends on Kysely `^0.28.17` and `pg` `^8.23.0`; Kysely 0.28 supports the package's Node.js baseline. Provide your own configured Kysely database instance and connection pool; the library does not own their lifecycle. From a checkout of this repository, apply the inspectable V1 migration **before** using the adapter:

```bash
psql "$DATABASE_URL" --single-transaction -v ON_ERROR_STOP=1 -f migrations/001_newsletter.sql
```

In deployments, review and run that SQL inside your host migration runner's transaction instead. The migration contains no `BEGIN` or `COMMIT`, so it does not prematurely commit an enclosing transaction. Importing `better-newsletter/kysely` does not create or alter tables. Apply future schema changes as new forward migrations; V1 does not promise a destructive rollback.

```ts
import { createNewsletter } from 'better-newsletter'
import { createHmacRateLimitKeyProvider } from 'better-newsletter/security'
import {
  kyselyRateLimiter,
  kyselyStorage,
  listEligibleSubscriptions
} from 'better-newsletter/kysely'

// db is the host application's configured Kysely instance for PostgreSQL.
const newsletter = createNewsletter({
  storage: kyselyStorage(db),
  mailer,
  capabilities,
  rateLimiter: kyselyRateLimiter(db),
  rateLimitKeyProvider: createHmacRateLimitKeyProvider({
    secret: process.env.NEWSLETTER_RATE_LIMIT_SECRET!
  })
})

const recipients = await listEligibleSubscriptions(db, 'default')
```

`listEligibleSubscriptions()` is a read-only recipient-selection helper for one audience. It selects only enabled Contacts with active, confirmed, not-unsubscribed Subscriptions. Re-check eligibility when sending if recipient state may have changed since selection; no campaign sending or scheduler is provided. Hosts that need another database or storage design can implement `NewsletterStorage` and `RateLimiter` directly.

The migration defines `newsletter_contacts`, `newsletter_subscriptions`, `newsletter_tokens`, `newsletter_events`, and `newsletter_rate_limits`. Contact, Subscription, and event IDs are application-generated `text` values: the core generates UUIDs by default, but injected generators may produce other unique strings. `email` must already be trimmed and lowercase and is globally unique; `(contact_id, audience_key)` is unique. Each Contact can link at most one external subject per newsletter instance through opaque `subject_namespace` and `subject_id` strings without a foreign key into the host application; the core controls replacement of an existing subject. Contact metadata and event metadata are JSON objects in `jsonb`; event types use the `event_type` text column. Subscription consent evidence is stored in `consent_version`, `consent_source`, `consent_locale`, and `consented_at`. Delivery work is stored in `confirmation_delivery_id`, `confirmation_attempt_id`, and `confirmation_lease_expires_at`. Both generation columns are positive `bigint` values and must remain within JavaScript's safe-integer range when mapped to the core.

Only confirmation-token digests, never raw confirmation tokens, belong in `newsletter_tokens`. Its identity `id` orders equal-timestamp records deterministically for bounded retention within `(subscription_id, lifecycle_generation)`; `sequence` gives events append order even when timestamps match. Store `capabilityGeneration` and `lifecycleGeneration` persistently; do not reset generations or reuse IDs. All state transitions, token mutations, and event appends must share one atomic transaction. Serialize conflicting transitions with `SERIALIZABLE` isolation or row locks, taking contact locks before subscription locks and token locks. Retry unique violations, serialization failures, and deadlocks through the storage conflict contract rather than continuing a failed transaction.

`newsletter_rate_limits` is an optional SQL fixed-window counter keyed by `(key_hash, action, window_ms, bucket_start_ms)`, with `attempt_count` and `expires_at`; including the window length prevents different configured policies from sharing a bucket. `kyselyRateLimiter(db)` performs atomic consumption across service instances and requires 64-character lowercase hex HMAC/SHA-256 keys, rejecting raw e-mail or IP keys. Rate-limit counters and expired token rows need explicit scheduled cleanup; neither import nor the core starts a scheduler. Keep HMAC signing and rate-limit secrets stable across process restarts and protect them outside the database. Rotating a signing secret invalidates outstanding unsubscribe links; rotating the rate-limit secret resets effective buckets.

Deleting a Contact cascades to its Subscriptions, token records, and lifecycle events, so intentional erasure removes historical evidence too. Events are otherwise append-only; the schema does not use an immutable-event trigger that would block erasure. Plan operational retention, exports, and erasure with that behavior in mind.

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

Set `DATABASE_URL` to a disposable PostgreSQL database to run the integration
tests (the test user needs `CREATE SCHEMA`). The tests create and remove their
own isolated schema; without `DATABASE_URL`, they are skipped. CI provisions a
temporary PostgreSQL service and runs them on every check.

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
- #4: Kysely/PostgreSQL persistence (implemented here);
- #5: Resend delivery adapter;
- #6: Nuxt/Nitro integration;
- #7: provider bounce/complaint feedback;
- #8: privacy export and erasure lifecycle.

## License

MIT
