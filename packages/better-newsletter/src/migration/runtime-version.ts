import runtimePackage from '../../package.json' with { type: 'json' }

/** Version of this runtime artifact, shared by the provider and canonical snapshot. */
export const BETTER_NEWSLETTER_VERSION: string = runtimePackage.version
