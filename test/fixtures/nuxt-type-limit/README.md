# Large Nitro route table reproduction

This fixture isolates #43 using the exact upstream version matrix defined in [package.json](package.json). Its dependencies, development dependencies and pnpm overrides are the source of truth for Nuxt, Nitro, TypeScript, vue-tsc, h3 and the other fixture dependencies. The smoke reads these pins directly. `setup.mjs` adds 300 synthetic, finite route responses to `InternalApi`. The route count is a test input, not a universal threshold.

The automated pack smoke copies this fixture to a clean consumer, replaces its workspace runtime dependency with the fresh tarball, first verifies literal request generics with all six newsletter routes retained, and then probes the pinned upstream TS2589 behavior both with and without newsletter routes.

For a standalone reproduction, copy this directory outside the workspace and replace `better-newsletter: workspace:*` in its package manifest with a freshly packed runtime tarball (`file:/absolute/path/better-newsletter-<version>.tgz`). Then, from that copy:

```bash
pnpm install --ignore-scripts --config.auto-install-peers=false
node setup.mjs broad
SMOKE_WITH_NEWSLETTER=false pnpm exec nuxt typecheck # expected TS2589
SMOKE_WITH_NEWSLETTER=true pnpm exec nuxt typecheck  # expected TS2589
node setup.mjs narrow
SMOKE_WITH_NEWSLETTER=true pnpm exec nuxt typecheck  # expected success
```

The **positive narrowed-request regression** is the durable Better Newsletter test: all six routes must remain in `InternalApi`, and the compiler must reject an incorrect literal request path and a GET call to the POST-only confirmation endpoint. No route-type deletion hook is used.

The **negative TS2589 reproduction** is intentionally version-bound upstream investigation evidence. It is not a permanent package invariant. If a future matrix makes a broad call succeed, the smoke reports a possible upstream fix and asks maintainers to re-evaluate the matrix and update or retire the negative reproduction. Reassess this documentation too; do not artificially restore TS2589. Keep the positive package regression. Other unexpected compiler or process errors remain failures.

See [the investigation](../../../docs/nuxt-route-types.md) for the trace evidence and full-consumer controls.
