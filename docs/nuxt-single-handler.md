# Nuxt single-handler integration (#48)

PR #47's finalized metadata contract is preserved: public subscribe metadata belongs to the concrete lifecycle event and never initializes Contact metadata.

## Responsibilities before and after

| Piece | Before | After |
| --- | --- | --- |
| Nuxt module | Validates public policy, serializes it, registers six POST handlers | Resolves server config and mounts one POST-only catch-all handler with `basePath` |
| `handleNewsletterRequest` | Validates body and delegates one preselected action to the service | Retained as private dispatch implementation behind `createNewsletterHandler`; validation and operations unchanged |
| Individual routes | Six files import virtual policy and select an action | Deleted; one server-only virtual handler adapts the mount |
| `#better-newsletter-options` | Serializes audience and consent policy for route imports | Deleted; no runtime policy serialization |
| `BetterNewsletterServerConfig` | Supplies storage, mailer, capabilities, trusted origin and request hooks | Also owns `publicApi` audience/consent policy and relative action overrides |
| `useBetterNewsletter(event)` | Request-cached trusted lifecycle service with rate limiting/background delivery | Retained; shares the request-cached server config with the handler |
| `createNewsletterClient()` | Requires a full absolute route map; action inputs are package-owned | Optional mount/relative overrides; package-owned inputs and standard POST fetch; no Nuxt type imports |
| Enable/disable/move | Separate Nitro route registrations | Internal action table, with disabled/unknown/old moved paths returning 404 |
| Nitro typing regression | Six generated `InternalApi` entries and a version-pinned negative TS2589 probe | Packed client compile checks and public handler behavior; no per-action generated-type contract |

## Request paths

Before:

```text
POST /api/newsletter/subscribe
  -> Nitro's action-specific POST route
  -> nuxt/routes/subscribe
  -> serialized #better-newsletter-options + server config
  -> handleNewsletterRequest(event, 'subscribe', policy)
  -> request service -> framework-independent lifecycle operation
```

After:

```text
POST /api/newsletter/subscribe
  -> one Nitro POST /api/newsletter/** mount
  -> createNewsletterHandler({ basePath })
  -> request-cached server config -> internal action table -> POST check
  -> handleNewsletterRequest -> request service -> same lifecycle operation
```

H3 stays in the Nuxt adapter. The core, database schema, migration/CLI and host-owned forms, pages, mail templates, metadata validation and authenticated administration remain unchanged. Trusted server operations continue to call `useBetterNewsletter(event)` directly. The handler resolves configuration for routing but does not initialize the service or call metadata/security hooks for unknown actions or honeypot requests. Host configuration factories receive the current `H3Event` and are evaluated at most once per request. They can use host-owned request-scoped Nitro/Worker resources or reuse long-lived adapters; parameterless factories remain valid. The handler and trusted service share the request-local configuration. Better Newsletter does not own or close host resources, and waitUntil/await behavior is unchanged.

Request-scoped resources must remain valid until background delivery completes. If the host releases them when the HTTP response completes, configure `backgroundMode: 'await'` unless their lifetime is explicitly extended. Platform `waitUntil` extends execution lifetime; it does not automatically manage host-owned resources. With `backgroundMode: 'await'`, the Nuxt service waits for delivery work before `subscribe()` or `resendConfirmation()` resolves; host handlers must await these methods before completing the response.

## Removed and retained infrastructure

Removed: six `src/nuxt/routes/*` files, virtual options declaration/template, module public-policy validation, per-action registrations, the Nitro-specific smoke script and synthetic route-union fixture. The historical [#43 investigation](nuxt-route-types.md) remains as evidence, with its obsolete regression contract marked as retired.

Retained: server config virtual import, one small virtual mount adapter, Nitro linked-package inlining, body byte limit, consent/audience/honeypot validation, neutral responses, capability operations, all metadata and abuse/security hooks, trusted-client rate limiting and waitUntil/await delivery semantics. Existing security/lifecycle tests now run through the single handler; they were not replaced by mount-presence assertions.

Nitro can infer one catch-all entry rather than six specific entries. Newsletter actions no longer enlarge its route union independently. The package does not delete host-generated `InternalApi` entries and does not claim to fix Nitro's general typed matcher limit. Consumers use the package-owned client for newsletter action/input typing instead of relying on individual Nitro route/method inference.

## Packed-consumer ergonomics and validation

The packed Nuxt fixture mounts `/api/mail/**`, moves preferences to `/manage`, and calls every public lifecycle action against the built production server. It disables preferences at runtime to prove policy is enforced behind the mount. A trusted test-only host route accesses the direct service and inspects lifecycle events; it is not part of the package.

The fixture compiles valid client actions and rejects wrong actions, confirmation HTTP-option objects, unknown routing keys and false consent using `@ts-expect-error`. Browser output is checked for a server-only secret. Runtime checks cover host-selected subscribe/resubscribe event metadata, absence of Contact/client-forged metadata, security context and abuse rejection, trusted identity resolution, neutral responses, honeypot, explicit POST, moved paths and awaited delivery. Existing adapter tests and PostgreSQL/Kysely CI remain in place.

## Intentional prerelease changes

- Module options now contain only `basePath` and `configFile`. Move `defaultAudience`, `audiences`, `consent` and `routes` into server config `publicApi`.
- Action overrides are relative to the mount, such as `/resend`, instead of arbitrary absolute host endpoints. Move the whole API with `basePath`; a custom host endpoint remains host-owned and should disable the built-in action.
- Client configuration changes from a required full route map to optional `{ basePath, routes }`. The default client requires no configuration.
- Individual Nitro-generated route/method inference is no longer a package contract. The package-owned client provides action/input typing and always uses POST.
- `defaultNewsletterRoutes` and `NewsletterRoute` no longer belong to the Nuxt module entry. Routing types are available from the browser client entry, avoiding a Nuxt dependency.
- Public policy validation happens when resolving handler configuration rather than during Nuxt module setup.

No generic request hook was necessary. Existing distinct metadata, security context and background execution seams already cover the actual needs; no endpoint replacement system or callback family was added. No Better Auth source was copied.
