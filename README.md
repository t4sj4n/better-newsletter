# better-newsletter

Framework-agnostic newsletter subscription and consent lifecycle infrastructure for TypeScript.

> **Status:** early development. The core subscription lifecycle is implemented; production token hardening, database and delivery adapters follow in issues #3–#6.

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
  tokenGenerator,
  confirmation: {
    expiresInMs: 24 * 60 * 60 * 1000
  }
})
```

Time and IDs can be injected for deterministic tests.

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

It does not reveal whether the address is unknown, pending, active, unsubscribed or suppressed.

Confirmation is capability-based:

```ts
await newsletter.confirm({ token })
```

The capability contract is intentionally abstract in #2. Issue #3 owns cryptographic generation, hashed persistence, expiry cleanup, replay hardening and scanner-safe web integration.

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

Import is a trusted service operation, not a public signup path. Importing `ACTIVE` requires an explicit `confirmedAt`; the library never invents confirmation evidence. Repeating the same import is idempotent, while conflicting historical facts are rejected.

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

`memoryCapabilities()` stores raw opaque values in memory and is **not production security**. It exists to exercise #2 without prematurely implementing #3. Do not use it as a production confirmation/unsubscribe token store.

Production storage must provide transaction semantics strong enough to serialize conflicting Contact + audience transitions. The PostgreSQL/Kysely adapter in #4 will additionally enforce database uniqueness and atomicity.

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

- #3: cryptographic token/capability security, abuse protection and cleanup;
- #4: Kysely/PostgreSQL persistence;
- #5: Resend delivery adapter;
- #6: Nuxt/Nitro integration;
- #7: provider bounce/complaint feedback;
- #8: privacy export and erasure lifecycle.

## License

MIT
