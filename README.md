# better-newsletter

Framework-agnostic newsletter subscription and consent lifecycle infrastructure for TypeScript.

`better-newsletter` handles the lifecycle around a newsletter so your application does not have to rebuild it itself:

- a repeated signup stays idempotent instead of creating duplicate state;
- Double Opt-In, confirmation tokens and unsubscribe capabilities follow one consistent lifecycle;
- one e-mail address can have independent subscriptions to multiple audiences;
- bounces or manual suppression can block delivery globally without rewriting consent history.

You keep control of your database, mail provider, UI and application identity. `better-newsletter` provides the lifecycle and the integration points.

> **Status:** early development. The package has not been published to npm yet and the public API may still change before the first prerelease.

## Installation

Until the first npm prerelease, install a packed artifact from a local checkout:

```bash
# better-newsletter
pnpm install --frozen-lockfile
pnpm pack

# your application
pnpm add /path/to/better-newsletter-0.0.0.tgz
```

After the first prerelease is published:

```bash
pnpm add better-newsletter
```

Node.js 20.11 or newer is required.

## Basic usage

Create a newsletter instance by providing storage, mail delivery and secure capabilities:

```ts
import {
  createNewsletter,
  createSecureCapabilities
} from 'better-newsletter'

const newsletter = createNewsletter({
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
import { postgresStorage } from 'better-newsletter/postgres'
import { resendMailer } from 'better-newsletter/resend'

const storage = postgresStorage(db)

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
