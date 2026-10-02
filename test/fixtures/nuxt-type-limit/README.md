# Large Nitro route table reproduction

This fixture isolates #43 with Nuxt 4.5.2, Nitro 2.13.4, TypeScript 6.0.3 and vue-tsc 3.3.11. `setup.mjs` adds 300 synthetic, finite route responses to `InternalApi`. The route count is a test input, not a universal threshold.

The automated pack smoke copies this fixture to a clean consumer, replaces its workspace runtime dependency with the fresh tarball, verifies TS2589 both with and without newsletter routes, and then verifies literal request generics with all six newsletter routes retained.

For a standalone reproduction, copy this directory outside the workspace and replace `better-newsletter: workspace:*` in its package manifest with a freshly packed runtime tarball (`file:/absolute/path/better-newsletter-<version>.tgz`). Then, from that copy:

```bash
pnpm install --ignore-scripts --config.auto-install-peers=false
node setup.mjs broad
SMOKE_WITH_NEWSLETTER=false pnpm exec nuxt typecheck # expected TS2589
SMOKE_WITH_NEWSLETTER=true pnpm exec nuxt typecheck  # expected TS2589
node setup.mjs narrow
SMOKE_WITH_NEWSLETTER=true pnpm exec nuxt typecheck  # expected success
```

The narrow case also rejects an incorrect literal request path and a GET call to the POST-only confirmation endpoint. No route-type deletion hook is used.

See [the investigation](../../../docs/nuxt-route-types.md) for the trace evidence and full-consumer controls.
