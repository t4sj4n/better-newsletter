# Examples

These are small, copyable consumers of the **public** `better-newsletter` package exports. They show host integration rather than package internals. For multi-audience behavior, delivery failures, leases, suppression, and other advanced controls, use the separate [development playground](../playground/README.md).

| Example | Purpose | Demo |
| --- | --- | --- |
| [basic](basic/README.md) | Nuxt 4: one default audience, explicit consent, a local fake inbox, and signup → confirm → unsubscribe. | [![Open in StackBlitz](https://developer.stackblitz.com/img/open_in_stackblitz.svg)](https://stackblitz.com/github/t4sj4n/better-newsletter/tree/main/examples/basic) |

Future examples can illustrate other hosts and production storage/mail adapters without adding controls to the basic example.

## StackBlitz Demo

The basic Nuxt 4 example can be opened directly in StackBlitz:
- [https://stackblitz.com/github/t4sj4n/better-newsletter/tree/main/examples/basic](https://stackblitz.com/github/t4sj4n/better-newsletter/tree/main/examples/basic)

The demo runs completely in the browser using the in-memory adapter and fake mailer without external database or credentials.

## Version Maintenance

- **During prereleases (`alpha`, `beta`, `next`):** Examples must explicitly pin the exact published prerelease version (e.g. `"better-newsletter": "0.1.0-alpha.1"`) to guarantee reproducible builds and avoid breaking when uncoordinated changes land.
- **After stable release (`1.0.0+`):** The repository maintainers can decide whether the example should remain pinned to the current documented release or use `latest` / `^1.0.0` for automatic currency. For standalone reproducibility on StackBlitz, explicit pinning remains preferred.
