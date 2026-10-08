import { describe, expect, it } from 'vitest'
import { extractReleaseNotes } from '../scripts/extract-release-notes.mjs'
import process from 'node:process'

describe('extractReleaseNotes', () => {
  it('extracts release notes for an existing version from CHANGELOG.md', () => {
    const notes = extractReleaseNotes(process.cwd(), '0.1.0-beta.3')
    expect(notes).toContain('### 💅 Refactors')
    expect(notes).toContain('Simplify local releases with release-it')
    expect(notes).not.toContain('## v0.1.0-beta.3')
    expect(notes).not.toContain('## v0.1.0-beta.2')
  })

  it('throws when the version header is not found', () => {
    expect(() => extractReleaseNotes(process.cwd(), '99.99.99')).toThrow(
      'Version header "## v99.99.99" not found in CHANGELOG.md'
    )
  })
})
