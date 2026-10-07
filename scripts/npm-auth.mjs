import process from 'node:process'
import { repository } from './release-policy.mjs'

/** Real publishes run only through the manually dispatched trusted workflow. */
export function requireTrustedPublishing(env = process.env) {
  if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_EVENT_NAME !== 'workflow_dispatch'
      || env.GITHUB_WORKFLOW_REF !== `${repository}/.github/workflows/publish.yml@refs/heads/main`
      || !env.ACTIONS_ID_TOKEN_REQUEST_URL || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) {
    throw new Error('Publish through the Publish release workflow on main; npm authentication uses GitHub Actions OIDC.')
  }
  if (env.NPM_TOKEN || env.NODE_AUTH_TOKEN) {
    throw new Error('Remove NPM_TOKEN and NODE_AUTH_TOKEN; this workflow uses npm trusted publishing, not stored npm tokens.')
  }
}
