import console from 'node:console'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { checked, npmDistTag, liveCommandRunner, requireMainCommit, requireSuccessfulCi } from './release-core.mjs'
import { releaseArtifacts, releasePackages, repository, requiredCi } from './release-policy.mjs'
import { conciseMessage } from './script-errors.mjs'
import { artifactDirectory, publicationState, publishPackages, removeArtifacts, verifyManifest } from './release-publication.mjs'
import { requireTrustedPublishing } from './npm-auth.mjs'

export async function runReleaseHook(action, version, { cwd = process.cwd(), resume = false, tag = 'latest', run = liveCommandRunner(cwd) } = {}) {
  const channel = npmDistTag(tag)
  if (action === 'prepare-pr') {
    const branch = `release/v${version}`
    if (await checked(run, 'git', ['branch', '--show-current']) !== branch) throw new Error('Release branch changed before push.')
    await checked(run, 'git', ['push', '--set-upstream', 'origin', `HEAD:refs/heads/${branch}`])
    const existing = JSON.parse(await checked(run, 'gh', ['pr', 'list', '--repo', repository, '--head', branch, '--json', 'url']))
    console.log(existing[0]?.url ?? await checked(run, 'gh', ['pr', 'create', '--repo', repository, '--base', 'main',
      '--head', branch, '--draft', '--title', `🔖 Release v${version}`, '--body',
      `Prepare the synchronized runtime and CLI release v${version}. Review the release notes and wait for CI before squash-merging.`]))
    return
  }
  if (action === 'cleanup') return removeArtifacts(cwd, run, version)
  if (action !== 'publish') throw new Error(`Unknown release hook: ${action}`)
  requireTrustedPublishing()
  const packages = releasePackages(cwd)
  if (packages[0].version !== version) throw new Error('Package version changed after artifact validation.')
  const commit = await requireMainCommit(run)
  const directory = await artifactDirectory(cwd, run, version)
  const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'))
  const artifacts = releaseArtifacts(directory, packages)
  const actual = { commit, packages: artifacts.map(({ name, integrity }) => ({ name, integrity })) }
  if (JSON.stringify(actual) !== JSON.stringify(manifest)) throw new Error('Release artifacts or commit changed after validation.')
  await verifyManifest(run, version, manifest)
  // The native Git stage has just created the local tag; resume permits that expected state.
  const state = await publicationState(run, packages, commit, true)
  if (!resume && state.published.some(Boolean)) throw new Error('An npm version appeared during release; inspect it and resume.')
  await requireSuccessfulCi(run, repository, commit, requiredCi)
  try {
    if (state.plan.pushTag) await checked(run, 'git', ['push', 'origin', `refs/tags/v${version}`])
    console.log(`Publishing runtime and CLI v${version} with npm dist-tag ${channel}`)
    await publishPackages(run, { packages, artifacts, plan: state.plan, channel })
  } catch (error) {
    throw new Error(`Publication interrupted: ${error.message}\nKeep the tag and cached artifacts. Run the Publish release workflow on main again with release_commit=${commit}, resume=true and dist_tag=${channel}.`, { cause: error })
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    await runReleaseHook(process.argv[2], process.argv[3], { resume: process.argv.includes('--resume'),
      tag: process.argv.includes('--tag') ? process.argv[process.argv.indexOf('--tag') + 1] : undefined })
  } catch (error) {
    console.error(process.argv.includes('--verbose') ? error.stack : conciseMessage(error.message))
    process.exitCode = error.exitCode ?? 1
  }
}
