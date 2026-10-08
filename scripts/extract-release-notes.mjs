import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import console from 'node:console'

/**
 * Extracts the exact release notes entry for a given version from CHANGELOG.md.
 * Ensures the GitHub Release notes match CHANGELOG.md byte-for-byte.
 */
export function extractReleaseNotes(cwd, version) {
  const changelogPath = join(cwd, 'CHANGELOG.md')
  const content = readFileSync(changelogPath, 'utf8')
  
  // Find entry starting with `## v<version>` as a full line header
  const headerRegex = new RegExp(`^##\\s+v${version.replaceAll('.', '\\.')}(?:\\r?\\n|$)`, 'mu')
  const match = headerRegex.exec(content)
  if (!match) {
    throw new Error(`Version header "## v${version}" not found in CHANGELOG.md`)
  }
  const startIndex = match.index
  const matchLength = match[0].length

  // Find the next version header `\n## ` or end of file
  const rest = content.slice(startIndex + matchLength)
  const nextHeaderMatch = rest.search(/\n## /u)
  
  let entry = nextHeaderMatch === -1 
    ? rest.trim() 
    : rest.slice(0, nextHeaderMatch).trim()

  // Strip the title line `## v<version>` itself since GitHub Release already has the title as the release tag/name
  entry = entry.replace(/^##\s+v[^\n]*\n+/u, '').trim()

  return entry
}

if (process.argv[1] && process.argv[1].endsWith('extract-release-notes.mjs')) {
  const version = process.argv[2]
  if (!version) {
    console.error('Usage: node scripts/extract-release-notes.mjs <version>')
    process.exit(1)
  }
  try {
    const notes = extractReleaseNotes(process.cwd(), version)
    process.stdout.write(notes + '\n')
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
}
