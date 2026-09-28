# better-newsletter

Framework-agnostic newsletter subscription and consent lifecycle infrastructure for TypeScript.

> **Status:** early development. The domain foundation is being built in issue #1; lifecycle operations are added in the following issues.

## Why this package exists

Applications commonly need a small, security-conscious layer for newsletter consent without adopting a full campaign platform. `better-newsletter` is intended to own the reusable subscription lifecycle while leaving UI, application identity, campaigns, analytics, and provider-specific infrastructure outside the core.

The project is deliberately narrower than a newsletter product:

- explicit newsletter consent;
- Double Opt-In lifecycle;
- per-audience subscription state;
- global delivery suppression;
- auditable lifecycle evidence;
- provider-neutral storage and mail boundaries;
- optional linking to an application-owned subject.

It is **not** a campaign editor, CRM, marketing automation suite, authentication library, or segmentation/query engine.

## Domain model

A contact is the delivery identity. A subscription is the consent state for one audience.

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
- one e-mail address can therefore have multiple independent subscriptions;
- suppressing delivery does not rewrite historical consent state.

V1 uses opaque `audienceKey` strings rather than introducing a list-management subsystem. A single-newsletter application can simply use the built-in `default` audience.

## External application subjects

A Contact may optionally link to an application-owned entity:

```ts
type ExternalSubject = {
  namespace: string
  id: string
}
```

For example:

```ts
{
  namespace: 'tipplabor-user',
  id: '550e8400-e29b-41d4-a716-446655440000'
}
```

The reference is intentionally opaque. `better-newsletter` does not query, own, or require the application's user table. Linking a subject is identity metadata only and must never create newsletter consent.

## Delivery eligibility

The core exposes one shared eligibility rule:

```ts
import {
  getDeliveryEligibility,
  CONTACT_STATUSES,
  SUBSCRIPTION_STATUSES
} from 'better-newsletter'
```

A subscription is eligible only when:

```text
Contact.status == ENABLED
AND Subscription.status == ACTIVE
AND confirmedAt is present
AND unsubscribedAt is absent
```

Future storage and campaign integrations should consume or parity-test against this rule rather than recreating their own interpretation of newsletter status.

## Factory and dependency boundary

The initial factory establishes dependency injection without binding the root package to a framework, database, or mail provider:

```ts
import { createNewsletter } from 'better-newsletter'

const newsletter = createNewsletter({
  storage,
  mailer,
  confirmation: {
    expiresInMs: 24 * 60 * 60 * 1000
  }
})
```

Time and future token generation can be injected for deterministic tests:

```ts
const newsletter = createNewsletter({
  storage,
  mailer,
  clock: {
    now: () => new Date('2026-09-28T08:00:00.000Z')
  },
  tokenGenerator: {
    generate: () => 'test-token'
  }
})
```

The concrete storage and mail adapter contracts are intentionally completed alongside the lifecycle/security work in issues #2 and #3 rather than prematurely coupling the domain foundation to one persistence model.

## Planned lifecycle API

Issues #2 and #3 add the operational API on top of this foundation:

```ts
newsletter.subscribe(...)
newsletter.confirm(...)
newsletter.resendConfirmation(...)
newsletter.unsubscribe(...)
newsletter.unsubscribeAll(...)
newsletter.getContact(...)
newsletter.getSubscription(...)
newsletter.listSubscriptions(...)
newsletter.linkSubject(...)
newsletter.suppressContact(...)
newsletter.importSubscription(...)
```

The trusted import path is intended for migrating known historical consent facts. It must never be exposed as the public signup path and must never invent Double Opt-In evidence.

## Planned package shape

V1 remains one npm package. Optional integrations will use subpath exports rather than separate packages:

```ts
import { createNewsletter } from 'better-newsletter'

// Planned:
import { memoryStorage } from 'better-newsletter/memory'
import { kyselyStorage } from 'better-newsletter/kysely'
import { resendMailer } from 'better-newsletter/resend'
```

Nuxt/Nitro support is also planned as a thin adapter. The core itself must not import Nuxt, Nitro, Vue, Kysely, PostgreSQL, Resend, or Better Auth.

## Lifecycle evidence

The domain defines append-only lifecycle events for evidence and diagnostics, including concepts such as:

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
IMPORTED
```

The current Contact and Subscription remain the operational source of truth. Events are evidence/history, not an event-sourced reconstruction requirement.

## Development

This repository uses pnpm.

```bash
pnpm install
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

Tipplabor is the primary behavioral reference for the first implementation because it already exercises a real Double Opt-In flow, hashed confirmation tokens, resend throttling, neutral public responses, unsubscribe capabilities, event history, and concurrency edge cases.

Relevant reference points:

- https://github.com/t4sj4n/tipplabor/issues/65
- https://github.com/t4sj4n/tipplabor/blob/staging/frontend/server/repositories/newsletter-opt-in-repository.ts
- https://github.com/t4sj4n/tipplabor/blob/staging/frontend/server/utils/waitlist-email.ts
- https://github.com/t4sj4n/tipplabor/blob/staging/frontend/server/database/migrations/082_newsletter_history_and_launch_cutoff.ts

The goal is to generalize proven behavior and tests, **not** to copy Tipplabor-specific routes, tables, UI text, account models, launch logic, or Cloudflare assumptions.

### listmonk

[listmonk](https://github.com/knadh/listmonk) is a useful architectural reference for separating subscriber-wide state from per-list subscription state and for thinking through preference-management edge cases.

listmonk is licensed under AGPLv3. This MIT project uses it only as a non-normative design reference. **Do not copy or port listmonk implementation code.**

## Scope of issue #1

Issue #1 establishes:

- strict TypeScript/ESM package foundation;
- Contact and Subscription domain types;
- opaque external-subject references;
- lifecycle-event types;
- one central delivery-eligibility rule;
- factory/dependency-injection boundaries;
- typed semantic errors;
- documentation and tests for the foundation.

Actual subscribe/confirm/unsubscribe behavior belongs to #2. Token security and abuse protection belong to #3.

## License

MIT
