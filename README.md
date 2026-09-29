# better-newsletter

Framework-agnostic newsletter subscription and consent lifecycle infrastructure for TypeScript.

> **In short:** Better Newsletter takes care of the awkward parts around newsletter signups: confirming an address, remembering consent, handling unsubscribe links, and keeping repeat signups consistent. You keep your own database, mail provider and UI — Better Newsletter handles the lifecycle behind them.

Instead of rebuilding the same edge cases in every app, you get predictable behavior for common flows:

- repeated signups stay idempotent instead of creating duplicate state;
- Double Opt-In, confirmation tokens and unsubscribe capabilities follow one consistent lifecycle;
- one e-mail address can have independent subscriptions to multiple audiences;
- bounces or manual suppression can block delivery globally without rewriting consent history.

> **Status:** early development. The package has not been published to npm yet and the public API may still change before the first prerelease.

## Installation

Until the first npm prerelease, install packed artifacts from a local checkout:

```bash
# better-newsletter repository
pnpm install --frozen-lockfile
mkdir -p artifacts
pnpm --dir packages/better-newsletter pack --pack-destination ../../artifacts
pnpm --dir packages/cli pack --pack-destination ../../artifacts

# your application
pnpm add /path/to/artifacts/better-newsletter-0.0.0.tgz
pnpm add -D /path/to/artifacts/better-newsletter-cli-0.0.0.tgz
```

After the first prerelease is published:

```bash
pnpm add better-newsletter
pnpm add -D @better-newsletter/cli
```

Node.js 20.11 or newer is required.

### Set up the database

Better Newsletter never changes your database schema during normal application startup.

For PostgreSQL, expose a migration config from `better-newsletter.config.ts` or `server/better-newsletter.config.ts`:

```ts
import { defineBetterNewsletterMigrationConfig } from 'better-newsletter/db/migration'
import { postgresMigration } from 'better-newsletter/adapters/postgres'

export const migration = defineBetterNewsletterMigrationConfig({
  provider: postgresMigration(db)
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

Both commands are safe to run again when the schema is already current. Use `--yes` for non-interactive deployments.

## Basic usage

Create a newsletter instance by providing storage, mail delivery and secure capabilities:

```ts
import { betterNewsletter } from 'better-newsletter'
import { createSecureCapabilities } from 'better-newsletter/security'

const newsletter = betterNewsletter({
  storage,
  mailer,
  capabilities: createSecureCapabilities({
    hmacSecret: process.env.NEWSLETTER_LINK_SECRET!
  })
})
```

The host application owns `storage` and `mailer`. Built-in PostgreSQL and Resend integrations are available, or you can implement the provider-neutral contracts yourself.

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

A new subscription starts as pending confirmation. Confirm it with the token delivered by your mailer:

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

See [examples/basic](examples/basic/README.md) for a minimal Nuxt example.

## License

MIT
