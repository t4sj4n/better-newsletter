import console from 'node:console'
import process from 'node:process'
import { fileURLToPath, URL } from 'node:url'
import { styleText } from 'node:util'
import release from 'release-it'
import { checked, githubRelease, npmDistTag, prereleaseChannel, liveCommandRunner, validVersion } from './release-core.mjs'
import { conciseMessage } from './script-errors.mjs'
import { releaseNotes, releasePackages, repository } from './release-policy.mjs'

const workflow = fileURLToPath(new URL('./release-workflow.mjs', import.meta.url))
const hooks = fileURLToPath(new URL('./release-hooks.mjs', import.meta.url))
const notes = fileURLToPath(new URL('./release-notes.mjs', import.meta.url))
const quote = value => `'${value.replaceAll("'", "'\\''")}'`

export function parseReleaseArgs(args, kind) {
  const options = { dryRun: false, resume: false, verbose: false, ci: false, tag: 'latest' }
  const selectors = []
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--resume' && kind === 'publish') options.resume = true
    else if (['--verbose', '--debug', '-V'].includes(arg)) options.verbose = true
    else if (arg === '--tag' && kind === 'publish') {
      const tag = args[++index]
      if (!tag || tag.startsWith('-')) throw new Error('--tag requires an npm dist-tag, for example --tag next.')
      options.tag = npmDistTag(tag)
    }
    else if (arg.startsWith('--tag=') && kind === 'publish') options.tag = npmDistTag(arg.slice(6))
    else if (arg === '--ci') options.ci = true
    else if (['--help', '-h'].includes(arg)) options.help = true
    else if (arg.startsWith('-')) throw new Error(`Unknown option ${arg}. Use --dry-run, --verbose, --debug${kind === 'publish' ? ', --resume or --tag <tag>' : ''}.`)
    else selectors.push(arg)
  }
  if (selectors.length > (kind === 'prepare' ? 1 : 0)) throw new Error('Prepare accepts one version selector; publish uses the prepared package version.')
  if (selectors[0] && !['prerelease', 'patch', 'minor', 'major', 'prepatch', 'preminor', 'premajor'].includes(selectors[0])) validVersion(selectors[0])
  return { ...options, increment: selectors[0] }
}

export function releaseConfig(kind, options, cwd = process.cwd(), releaseExists = false) {
  const prepare = kind === 'prepare'
  const version = releasePackages(cwd)[0].version
  const hook = action => `node ${quote(hooks)} ${action} "\${version}"${prepare ? '' : ` --tag ${quote(npmDistTag(options.tag))}`}${options.resume ? ' --resume' : ''}${options.verbose ? ' --verbose' : ''}`
  return {
    preReleaseId: version.includes('-') ? prereleaseChannel(version) : 'beta',
    config: false, releaseManifest: 'Not validated in dry-run', increment: prepare ? options.increment : false,
    'dry-run': options.dryRun, verbose: options.verbose ? 2 : 0,
    ci: options.ci || !process.stdin.isTTY, npm: false,
    plugins: {
      '@release-it/bumper': {
        in: 'packages/better-newsletter/package.json',
        ...(prepare ? { out: ['packages/better-newsletter/package.json', 'packages/cli/package.json'] } : {})
      },
      [workflow]: { kind, resume: options.resume, increment: options.increment }
    },
    git: {
      requireCleanWorkingDir: !options.dryRun,
      requireBranch: prepare && !options.dryRun ? 'main' : false,
      requireUpstream: false, commit: prepare, commitMessage: '🔖 Release v${version}',
      tag: !prepare, tagName: 'v${version}',
      tagAnnotation: 'Release v${version}\n\nRelease-Manifest: ${releaseManifest}',
      // Native pushes include a branch. Hooks push only explicit release refs.
      push: false, pushRepo: 'origin', changelog: prepare ? `node ${quote(notes)}` : false
    },
    github: {
      release: !prepare && !releaseExists, tokenRef: 'NEWSLETTER_RELEASE_TOKEN',
      skipChecks: options.dryRun, releaseName: 'v${version}',
      releaseNotes: () => releaseNotes(cwd, version), makeLatest: false
    },
    hooks: prepare ? { 'after:release': hook('prepare-pr') } : releaseExists
      ? { 'after:release': [hook('publish'), hook('cleanup')] }
      : { 'before:github:release': hook('publish'), 'after:github:release': hook('cleanup') }
  }
}

export async function executeRelease(kind, options) {
  const cwd = process.cwd()
  const run = liveCommandRunner(cwd)
  const version = releasePackages(cwd)[0].version
  const existing = kind === 'publish' && options.resume && !options.dryRun
    ? await githubRelease(run, repository, `v${version}`) : null
  const previous = process.env.NEWSLETTER_RELEASE_TOKEN
  try {
    if (kind === 'publish') process.env.NEWSLETTER_RELEASE_TOKEN = options.dryRun ? 'dry-run'
      : process.env.GH_TOKEN || process.env.GITHUB_TOKEN || await checked(run, 'gh', ['auth', 'token'])
    try {
      return await release(releaseConfig(kind, options, cwd, Boolean(existing)))
    } catch (error) {
      error.reportedByReleaseIt = true
      throw error
    }
  } finally {
    if (previous === undefined) delete process.env.NEWSLETTER_RELEASE_TOKEN
    else process.env.NEWSLETTER_RELEASE_TOKEN = previous
  }
}

export async function runReleaseCli(kind, args = process.argv.slice(2)) {
  const verbose = args.some(arg => ['--verbose', '--debug', '-V'].includes(arg))
  try {
    const options = parseReleaseArgs(args, kind)
    if (options.help) {
      console.log(`Usage: pnpm release:${kind}${kind === 'prepare' ? ' [prerelease|patch|minor|major|version]' : ' [--resume] [--tag <tag>]'} [--dry-run] [--verbose|--debug] [--ci]`)
      return
    }
    if (kind === 'prepare' && !options.increment && !process.stdin.isTTY) throw new Error('Version selection requires a terminal. Pass a selector or explicit version, for example: pnpm release:prepare prerelease --dry-run')
    await executeRelease(kind, options)
  } catch (error) {
    if (!error.reportedByReleaseIt) console.error(styleText('red', 'ERROR'), conciseMessage(error.message))
    if (verbose) console.error(error.stack)
    process.exitCode = error.name === 'ExitPromptError' ? 130 : error.exitCode ?? 1
  }
}
