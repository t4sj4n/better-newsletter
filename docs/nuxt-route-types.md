# Nitro route typing investigation (#43)

## Finding

The reported `TS2589: Type instantiation is excessively deep and possibly infinite` is reproducible in a large Nuxt consumer when Better Newsletter routes remain in Nitro's generated `InternalApi`.

The limiting computation belongs to Nitro's typed route matcher. A TypeScript 6.0.3 trace identifies `CalcMatchScore` route-segment types in `nitropack/dist/types/index.d.ts` and reaches **5,000,000 instantiations at depth 11**. The diagnostic does not establish an infinitely recursive newsletter response type.

Nuxt 4.5.2's `useFetch` defaults its request generic to `NitroFetchRequest`. Supplying only a response generic, such as `useFetch<Item[]>(...)`, leaves the request generic at that broad default. Nitro then evaluates route matching over the application route table to determine available methods. Enough matching work can exhaust TypeScript's per-expression instantiation budget. The point where this happens depends on route shapes and the surrounding expression; there is no universal safe route count.

Sources: [Nuxt 4.5.2 useFetch types](https://github.com/nuxt/nuxt/blob/v4.5.2/packages/nuxt/src/app/composables/fetch.ts), [related upstream report](https://github.com/nuxt/nuxt/issues/33735), and [Nitro typed fetch tracking](https://github.com/nitrojs/nitro/issues/2758).

## Controlled checks

The affected application's source was copied to an isolated directory. Application checkout files and dependencies were not edited. Nuxt 4.5.2, Nitro 2.13.4, h3 1.15.11, TypeScript 6.0.3 and vue-tsc 3.3.11 were used.

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

[`test/fixtures/nuxt-type-limit`](../test/fixtures/nuxt-type-limit/) contains only a finite `Item` response, a small Nuxt configuration, and a generator for 300 synthetic route types. There are no host business types, recursive JSON models or database dependencies. The synthetic entries model a large generated route table; only `/api/items` and the newsletter endpoints are actual registered HTTP handlers.

The pack smoke installs the freshly packed runtime in a clean consumer with pinned Nuxt/Nitro/TypeScript versions, then verifies:

1. `useFetch<Item[]>` reproduces TS2589 with the newsletter module disabled.
2. The same call reproduces TS2589 with all six newsletter routes enabled.
3. Literal request generics typecheck with the module enabled, all six entries retained in generated `InternalApi`, and invalid route/method calls rejected.

Run the automated check from the repository:

```bash
node scripts/smoke-pack.mjs
```

The fixture README provides the isolated reproduction commands. The negative checks intentionally expect TS2589 with the pinned upstream versions; reassess them when updating those versions.

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

These examples describe the verified Nuxt 4.5.2/Nitro 2.13.4 signatures. Dynamic or computed paths require an appropriate bounded request type rather than copying an unrelated literal. Explicit response types remain a caller declaration, not runtime validation.

The synthetic reproduction fails without newsletter routes, and replacing their response types does not fix the affected application. Better Newsletter's handler runtime, route registration and public service API therefore do not need a speculative change for this finding. Keep module route types available so callers retain method/path checking; deleting all module entries discards those checks.

The host can narrow its affected call sites while upstream improves route matching. This investigation resolves the ownership question in #43 and supplies a verified consumer mitigation; it does not claim to fix Nitro's general matcher performance for arbitrary applications.
