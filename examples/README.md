# Examples

These are small, copyable consumers of the **public** `better-newsletter` package exports. They show host integration rather than package internals. For multi-audience behavior, delivery failures, leases, suppression, and other advanced controls, use the separate [development playground](../playground/README.md).

| Example | Purpose |
| --- | --- |
| [basic](basic/README.md) | Nuxt 4: one default audience, explicit consent, a local fake inbox, and signup → confirm → unsubscribe. |

Future examples can illustrate other hosts and production storage/mail adapters without adding controls to the basic example.

Until the first npm prerelease in issue #16, `basic` uses `better-newsletter: workspace:*`. Issue #16 will switch it to the published package and add a StackBlitz link. There is no live StackBlitz example yet.
