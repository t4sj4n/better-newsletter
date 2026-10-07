import { describe, expect, it } from 'vitest'
import { requireTrustedPublishing } from '../scripts/npm-auth.mjs'

const trusted = () => ({
  GITHUB_ACTIONS: 'true',
  GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_WORKFLOW_REF: 't4sj4n/better-newsletter/.github/workflows/publish.yml@refs/heads/main',
  ACTIONS_ID_TOKEN_REQUEST_URL: 'https://example.test/oidc',
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'test-oidc-request-token'
})

describe('npm trusted publishing', () => {
  it('accepts the manually dispatched main workflow with OIDC available', () => {
    expect(() => requireTrustedPublishing(trusted())).not.toThrow()
  })
  it.each([
    { GITHUB_ACTIONS: '' },
    { GITHUB_EVENT_NAME: 'pull_request' },
    { GITHUB_WORKFLOW_REF: 't4sj4n/better-newsletter/.github/workflows/publish.yml@refs/heads/feature' },
    { GITHUB_WORKFLOW_REF: 'other/repo/.github/workflows/publish.yml@refs/heads/main' },
    { ACTIONS_ID_TOKEN_REQUEST_URL: '' },
    { ACTIONS_ID_TOKEN_REQUEST_TOKEN: '' }
  ])('rejects execution outside the trusted workflow (%j)', overrides => {
    expect(() => requireTrustedPublishing({ ...trusted(), ...overrides })).toThrow('Publish through the Publish release workflow')
  })
  it.each(['NPM_TOKEN', 'NODE_AUTH_TOKEN'])('rejects a stored %s instead of silently falling back to token authentication', key => {
    expect(() => requireTrustedPublishing({ ...trusted(), [key]: 'test-only-token' })).toThrow('Remove NPM_TOKEN and NODE_AUTH_TOKEN')
  })
})
