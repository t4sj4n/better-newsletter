# Nuxt 4 / Nitro development playground

This playground consumes the repository's public package exports through a local link (`link:..`), uses process-local `memoryStorage()` and `memoryCapabilities()`, and a server-only fake mailer. No database, Resend account, API key or real email is needed. It is **not a production starter**: every restart loses consent, confirmation links and signing keys. Production builds cannot use the demo service or the development-only inbox/control endpoints.

## Run locally

Use Node.js 20.11+ and pnpm. From the repository root:

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm --dir playground dev
```

The root install includes this playground through `pnpm-workspace.yaml`. It still links the library as a package and imports only its public exports. To validate the entire Nuxt app, run `pnpm --dir playground typecheck` and `pnpm --dir playground build` after the library build.

Visit `http://localhost:3000`. If you run on a different origin, set `DEMO_APP_ORIGIN` to that fixed URL **before** starting Nuxt (for example, `DEMO_APP_ORIGIN=http://localhost:3001 pnpm --dir playground dev --port 3001`). The application supplies this trusted origin; no incoming Host header is used to build links.

`nuxt.config.ts` registers `BetterNewsletter` from `better-newsletter/nuxt` with a public allowlist for `default`, `product-news` and `weekly-analysis`, and a fixed consent version/source. `server/better-newsletter.config.ts` uses the server-only `defineBetterNewsletterConfig` factory with a trusted application origin. Demo-only routes call the server-only `useBetterNewsletter(event)` accessor. The module owns five POST lifecycle endpoints and the read-only POST preferences endpoint; the example provides pages and **development-only** helper routes, not replacement public lifecycle endpoints.

## Walk through the lifecycle

1. Enter an address, select one or more audiences, explicitly check the consent box and request confirmation. The client sends `consent: true` and the configured `consentVersion: 'demo-privacy-v1'`; the server adds the configured source. A hidden `website` honeypot field is sent with signup. Public responses are neutral; they do not disclose whether an email already has a subscription.
2. Refresh the **development inbox** after delivery. Without platform `waitUntil`, the Nuxt server helper awaits delivery before the subscribe/resend Promise resolves; with `waitUntil`, refresh after the background work completes. Custom handlers do not need an extra `flushBetterNewsletter()` call after awaiting these methods. The inbox offers confirmation links for the last accepted message. Follow a link: GET displays a landing page without a mutation. Press **Confirm subscription** to POST the token. The inbox then shows `ACTIVE` for the confirmed audience.
3. Send the confirmation email again for a pending audience. To simulate a temporarily unavailable mail provider, select an audience, arm **Temporary failure**, then subscribe or send the confirmation email again; another send-again action retries the unfinished work. To simulate interrupted/ambiguous delivery, arm that failure, send the confirmation email again, advance the demo clock by 11 seconds (past the 10-second lease), then send it again. An ambiguous result is not retried during its lease. A fresh token is used on retry.
4. To exercise token expiry, retain a confirmation page URL, advance the demo clock six minutes (tokens live five minutes), and **then** press its POST button. The expired token does not confirm; request a fresh link with resend.
5. Open a per-audience or unsubscribe-all link from the inbox. Its GET page is side-effect free; the explicit button POSTs the opaque capability. Per-audience unsubscribe leaves other audiences unchanged. Unsubscribe-all changes all subscriptions, not the Contact's global suppression state. A separate **preferences** link uses a distinct capability: the GET page displays no private state, and an explicit read-only POST lists audience keys, statuses and bearer unsubscribe capabilities (not the Contact email or subject). Invalid/stale capabilities reveal no subscriptions.
6. Use the demo-only suppression buttons: Contact status changes separately from per-audience consent. Sign up `demo-member@example.com` and press **Link fixed mock member** to see a server-owned subject reference added without changing consent. This fixture is **not** authentication. A real app must resolve a verified session before calling `linkSubject()`.

All raw confirmation tokens and unsubscribe/preferences capabilities remain in process memory or the development-only browser links; none are written to logs. The development inbox at `GET /api/demo/inbox` exposes bearer links and must never be enabled on a public deployment. Every `/api/demo/*` handler checks development mode, and the fake in-memory configuration refuses to run outside development. Do not replace these checks with an easily guessed query parameter. The delivery-failure toggles and adjustable demo clock are testing conveniences, not production patterns.

For a real CAPTCHA or custom abuse signal, supply a server-only `securityContext(event, body)` callback in `server/better-newsletter.config.ts`; it passes transient metadata to the core `abuseGuard` and `rateLimitKeyProvider` on subscribe/resend. This demo uses only the `website` honeypot. Verify CAPTCHA tokens server-side, derive any client identity from trusted infrastructure (never a claimed IP in the body), and HMAC rate-limit keys rather than persisting raw IPs.

## Using a packed package

For a published-artifact smoke test from the repository root:

```bash
pnpm build
pnpm pack --pack-destination playground
pnpm --dir playground add ./better-newsletter-<version>.tgz
pnpm --dir playground build
```

Replace `<version>` with the tarball name printed by `pnpm pack`. This changes the example's dependency for your local test; revert it to `"link:.."` afterward and remove the test tarball. Do not commit packed artifacts. The root README documents production Kysely/PostgreSQL + Resend configuration, route overrides/disablement, trusted origins, abuse protection and deployment background-task requirements.
