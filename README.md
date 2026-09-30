# better-newsletter

[![CI](https://img.shields.io/github/actions/workflow/status/t4sj4n/better-newsletter/ci.yml?branch=main&event=push&label=CI&logo=githubactions&style=flat-square)](https://github.com/t4sj4n/better-newsletter/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/better-newsletter?tag=next&logo=npm&style=flat-square)](https://www.npmjs.com/package/better-newsletter)
[![npm downloads](https://img.shields.io/npm/dm/better-newsletter?logo=npm&style=flat-square)](https://www.npmjs.com/package/better-newsletter)
[![license](https://img.shields.io/npm/l/better-newsletter?style=flat-square)](https://github.com/t4sj4n/better-newsletter/blob/main/LICENSE)

Framework-agnostic newsletter subscription and consent lifecycle infrastructure for TypeScript.

> **In short:** Better Newsletter takes care of the awkward parts around newsletter signups: confirming an address, remembering consent, handling unsubscribe links, and keeping repeat signups consistent. You keep your own database, mail provider and UI — Better Newsletter handles the lifecycle behind them.

Instead of rebuilding the same edge cases in every app, you get predictable behavior for common flows:

- repeated signups stay idempotent instead of creating duplicate state;
- Double Opt-In, confirmation tokens and unsubscribe capabilities follow one consistent lifecycle;
- one e-mail address can have independent subscriptions to multiple audiences;
- bounces or manual suppression can block delivery globally without rewriting consent history.
- trusted export and host-controlled deletion or anonymization cover Contact data and consent history.

> **Status:** early development (prerelease). Packages are published to npm under the `next` tag.

[![npm next version](https://img.shields.io/npm/v/better-newsletter/next?label=npm%20%40next)](https://www.npmjs.com/package/better-newsletter)

## Installation

Install the prerelease from npm:

```bash
pnpm add better-newsletter@next
pnpm add -D @better-newsletter/cli@next
```

Node.js 20.11 or newer is required for the packages. The Nuxt example requires Node.js 22.19 or newer.

### Set up the database

Better Newsletter never changes your database schema during normal application startup.

For PostgreSQL, install Kysely and a PostgreSQL driver (for example, `pnpm add kysely@^0.28.17 pg@^8`). Expose a migration config from `better-newsletter.config.ts` or `server/better-newsletter.config.ts`, using your application's configured Kysely `db`:

```ts
import { defineBetterNewsletterMigrationConfig } from 'better-newsletter/db/migration'
import { postgresMigration } from 'better-newsletter/adapters/postgres'

export const migration = defineBetterNewsletterMigrationConfig({
  provider: postgresMigration(db),
  close: () => db.destroy()
})
```

Then choose one of the two setup workflows:

```bash
# Apply the required schema directly
pnpm exec better-newsletter migrate

# Or generate SQL for your own migration system
pnpm exec better-newsletter generate --output ./migrations/better-newsletter.sql
```

**`migrate`** inspects the database, shows the required changes, asks for confirmation, and applies them.

**`generate`** inspects the same database but only writes the required SQL so you can review and apply it through your application's existing migration workflow.

Both commands exit without changes when the schema is already current. Use `--yes` to approve changes in non-interactive deployments. The CLI reads the named `migration` export from a server config; it does not invoke its default Nuxt factory.

## Basic usage

Create a newsletter instance by providing storage, mail delivery and secure capabilities:

```ts
import { betterNewsletter } from 'better-newsletter'
import { createSecureCapabilities } from 'better-newsletter/security'

const newsletter = betterNewsletter({
  storage,
  mailer,
  capabilities: createSecureCapabilities({
    secrets: [
      { version: 2, value: process.env.NEWSLETTER_LINK_SECRET_V2! },
      { version: 1, value: process.env.NEWSLETTER_LINK_SECRET_V1! }
    ]
  })
})
```

The host application owns `storage` and `mailer`. Built-in PostgreSQL and Resend integrations are available, or you can implement the provider-neutral contracts yourself. Keep every signing secret stable and use at least 32 bytes. The first versioned secret signs new links; retain previous versions to verify older links. For an existing `bn2` deployment, use the staged [rotation guide](packages/better-newsletter/README.md#production-security). Signed unsubscribe and manage-preferences links have no fixed expiry, so retiring an old signing key deliberately invalidates remaining links signed with it.

Subscribe with explicit consent:

```ts
await newsletter.subscribe({
  email: 'person@example.com',
  audience: 'default',
  consent: {
    granted: true,
    version: 'privacy-2026-09',
    source: 'signup-form'
  }
})
```

A new subscription starts as pending confirmation. The public signup response does not reveal subscription state, and confirmation delivery runs in the background. Confirm it with the token delivered by your mailer:

```ts
await newsletter.confirm({ token })
```

Create an unsubscribe capability from trusted server code and pass it to the unsubscribe action:

```ts
const capability = await newsletter.createUnsubscribeCapability({
  email: 'person@example.com',
  audience: 'default'
})

if (capability) {
  await newsletter.unsubscribe({ capability })
}
```

### PostgreSQL and Resend

```ts
import { postgresAdapter } from 'better-newsletter/adapters/postgres'
import { resendMailer } from 'better-newsletter/mailers/resend'

const storage = postgresAdapter(db)

const mailer = resendMailer({
  apiKey: process.env.RESEND_API_KEY!,
  from: 'Newsletter <news@example.com>',
  renderConfirmation: ({ token }) => ({
    subject: 'Confirm your subscription',
    text: `Confirm: https://example.com/newsletter/confirm?token=${encodeURIComponent(token)}`
  })
})
```

Use a verified sender and a trusted application origin for confirmation links. On runtimes that may stop work when a request ends, provide `runBackground` using the platform's `waitUntil`, or await the delivery task before replying. The Nuxt integration handles this for its routes.

### Nuxt

Add the module:

```ts
// nuxt.config.ts
import BetterNewsletter from 'better-newsletter/nuxt'

export default defineNuxtConfig({
  modules: [BetterNewsletter],
  betterNewsletter: {
    audiences: {
      default: { public: true }
    },
    consent: {
      version: 'v1',
      source: 'signup-form'
    }
  }
})
```

Then provide the server-side newsletter configuration:

```ts
// server/better-newsletter.config.ts
import { defineBetterNewsletterConfig } from 'better-newsletter/nuxt/server'

export default defineBetterNewsletterConfig(() => ({
  origin: 'https://example.com',
  storage,
  mailer,
  capabilities
}))
```

The Nuxt integration supplies the lifecycle API routes. Your application still owns the signup form, confirmation/unsubscribe pages and mail copy.

See [examples/basic](examples/basic/README.md) for a minimal Nuxt example ([try directly on StackBlitz](https://stackblitz.com/github/t4sj4n/better-newsletter/tree/main/examples/basic)) and the [runtime package documentation](packages/better-newsletter/README.md) for security, migrations, adapters and the full API.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for local development setup, test execution, and release workflows.

## License

MIT
