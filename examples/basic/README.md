# Basic Nuxt 4 example

A copyable, development-only consumer using the public `better-newsletter/nuxt`, `better-newsletter/nuxt/server`, `better-newsletter/adapters/memory` and `better-newsletter` exports. It has one public default audience, explicit checkbox consent (`basic-v1`), and no credentials, authentication, provider, or database.

## Run

Use Node.js 22.19+ and pnpm. From the repository root, build the linked package **before** starting the app:

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm --dir examples/basic dev
```

Visit `http://localhost:3000`. To run on another origin, set a **fixed** trusted origin before starting Nuxt, for example `BASIC_APP_ORIGIN=http://localhost:3001 pnpm --dir examples/basic dev --port 3001`. The app never constructs email links from incoming request headers. Run `pnpm --dir examples/basic typecheck` and `pnpm --dir examples/basic build` after building the package.

1. Enter an email address, explicitly check consent, and submit. The public subscribe response is neutral; it does not disclose whether an address is already registered. The Nuxt module receives `consent: true` and `consentVersion: 'basic-v1'`, supplies the server-owned source, and uses the allowlisted default audience.
2. Refresh the **local development inbox** for that address. The host's fake mailer renders confirmation email text and HTML in memory and sends nothing. Open the confirmation link: GET only renders a landing page. Press **Confirm subscription** to POST the token, then return and refresh the inbox to see `ACTIVE`.
3. Open the inbox's unsubscribe link. GET is side-effect free; press **Unsubscribe** to POST the capability, then refresh the inbox to see `UNSUBSCRIBED`.

The module owns the lifecycle POST routes. The host owns the fake mailer, fixed origin, development inbox route, and safe GET pages. Storage, signing keys and fake mail are process-local and disappear on restart. `POST /api/example/inbox` can reveal bearer links and subscription status for any address: it returns 404 outside development, and the example's server config also refuses production use. **Do not deploy this example** or expose the inbox in production. Production apps should use durable PostgreSQL/Kysely storage, stable secure capabilities, and a real provider such as Resend instead of the memory/fake adapters; add abuse protection and trusted rate limiting appropriate to your deployment. Never log or publish bearer URLs.

Until the first npm prerelease, `package.json` links the runtime with `workspace:*`. Issue #16 will replace that link with the published dependency and add a StackBlitz link; none is available yet.
