# Nitro route typing investigation (#43)

> Historical investigation of the six-route integration. Issue #48 replaced those routes with one handler and retired the synthetic negative probe and per-route `InternalApi` assertions. Paths and commands below describe the earlier implementation; see [the current architecture and migration](nuxt-single-handler.md). The upstream matcher finding remains relevant to unrelated host fetch calls.

## Finding

The reported `TS2589: Type instantiation is excessively deep and possibly infinite` is reproducible in a large Nuxt consumer when Better Newsletter routes remain in Nitro's generated `InternalApi`.

The limiting computation belongs to Nitro's typed route matcher. A TypeScript trace from the original investigation identifies `CalcMatchScore` route-segment types in `nitropack/dist/types/index.d.ts` and reaches **5,000,000 instantiations at depth 11**. The diagnostic does not establish an infinitely recursive newsletter response type.

The investigated Nuxt `useFetch` signature defaults its request generic to `NitroFetchRequest`. Supplying only a response generic, such as `useFetch<Item[]>(...)`, leaves the request generic at that broad default. Nitro then evaluates route matching over the application route table to determine available methods. Enough matching work can exhaust TypeScript's per-expression instantiation budget. The point where this happens depends on route shapes and the surrounding expression; there is no universal safe route count.

Sources: [Investigated Nuxt useFetch types](https://github.com/nuxt/nuxt/blob/v4.5.2/packages/nuxt/src/app/composables/fetch.ts), [related upstream report](https://github.com/nuxt/nuxt/issues/33735), and [Nitro typed fetch tracking](https://github.com/nitrojs/nitro/issues/2758).

## Controlled checks

The affected application's source was copied to an isolated directory. Application checkout files and dependencies were not edited. The original checks used the version matrix recorded in the [fixture manifest at commit 9041efb](https://github.com/t4sj4n/better-newsletter/blob/9041efb1f3497632fdc90896bf364723e437bec7/test/fixtures/nuxt-type-limit/package.json). The maintained probe matrix is defined in the [historical fixture package.json](https://github.com/t4sj4n/better-newsletter/blob/6e6a085/test/fixtures/nuxt-type-limit/package.json); smoke code reads its dependencies, development dependencies and pnpm overrides directly.

| Change in the isolated consumer | Result |
| --- | --- |
| Remove only the newsletter route-type deletion workaround | TS2589 at the first `useFetch` in a layout's `Promise.all`; subsequent type errors |
| Restore the original workaround | Typecheck passes |
| Retain routes but replace newsletter response expressions with `{ accepted: true }` | Same TS2589 |
| Additionally rename those entries to unrelated infrastructure paths | Same TS2589 |
| Retain original handler expressions and supply literal request generics to the three affected layout calls | Complete typecheck passes |

The explicit response generic was also removed from those three calls as a control; that alone did not remove TS2589 in this consumer.

A separate small packed consumer passes with all six built-in routes. Its success alone does not cover this large-table failure.

## Host-independent reproduction

[`test/fixtures/nuxt-type-limit`](https://github.com/t4sj4n/better-newsletter/tree/6e6a085/test/fixtures/nuxt-type-limit) contains only a finite `Item` response, a small Nuxt configuration, and a generator for 300 synthetic route types. There are no host business types, recursive JSON models or database dependencies. The synthetic entries model a large generated route table; only `/api/items` and the newsletter endpoints are actual registered HTTP handlers.

The pack smoke installs the freshly packed runtime in a clean consumer using the fixture manifest's exact upstream version matrix. It distinguishes two contracts:

- **Positive Better Newsletter regression:** literal request generics must typecheck with all six module routes retained in generated `InternalApi`. Invalid HTTP methods and literal request paths must still be rejected. This runs first and remains the package guarantee when upstream versions change.
- **Negative upstream probe:** `useFetch<Item[]>` intentionally reproduces TS2589 both with the newsletter module disabled and with all six newsletter routes enabled. This is version-pinned investigation evidence, not a permanent Better Newsletter invariant.

Run the automated check from the repository:

```bash
node scripts/smoke-pack.mjs
```

The fixture README provides the isolated reproduction commands. If a broad call unexpectedly typechecks successfully, the smoke emits a maintenance error identifying the version matrix and advising maintainers to re-evaluate, update or retire the negative probe. Success may indicate an upstream fix; do not artificially restore TS2589 by enlarging the fixture or changing its types. Reassess the reproduction and documentation while retaining the positive package test. Unexpected compiler errors or process failures remain test failures.

## Resolution and ownership

In affected calls, narrow the request generic as well as the response:

```ts
import type { NuxtError } from '#app'

interface Item { id: string }

const { data } = await useFetch<Item[], NuxtError, '/api/items'>(
  '/api/items',
  { default: () => [] }
)
```

For an explicit `$fetch` response generic, its second generic is the request:

```ts
const result = await $fetch<{ confirmed: boolean }, '/api/newsletter/confirm'>(
  '/api/newsletter/confirm',
  { method: 'POST', body: { token } }
)
```

These examples describe the signatures verified in the original investigation. Dynamic or computed paths require an appropriate bounded request type rather than copying an unrelated literal. Explicit response types remain a caller declaration, not runtime validation.

The synthetic reproduction fails without newsletter routes, and replacing their response types does not fix the affected application. Better Newsletter's handler runtime, route registration and public service API therefore do not need a speculative change for this finding. Keep module route types available so callers retain method/path checking; deleting all module entries discards those checks.

The host can narrow its affected call sites while upstream improves route matching. This investigation resolves the ownership question in #43 and supplies a verified consumer mitigation; it does not claim to fix Nitro's general matcher performance for arbitrary applications.
