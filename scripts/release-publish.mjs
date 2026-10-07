import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { checked, distTag, githubRelease, liveCommandRunner, npmVersion, publishPlan, registry, requireCleanTree, requireCurrentMain, requireGitHub, requireSuccessfulCi, tagState } from './release-core.mjs'
import { requireDryRunSnapshot, withReleaseDryRun } from './release-dry-run.mjs'
import { releaseArtifacts, releaseNotes, releasePackages, repository, requiredCi, requirePreparedCommit, validateArtifacts, validatePreparation } from './release-policy.mjs'
import { createReleaseUi, releaseCommand, runReleaseCli, validateReleaseOptions } from './release-ui.mjs'

async function verifyTagManifest(run, tag, manifest) {
  if (await checked(run, 'git', ['cat-file', '-t', `refs/tags/${tag}`]) !== 'tag') {
    throw new Error('Recovery requires the annotated tag created by release:publish.')
  }
  const annotation = await checked(run, 'git', ['cat-file', '-p', `refs/tags/${tag}`])
  const stored = /^Release-Manifest: (.+)$/mu.exec(annotation)?.[1]
  if (!stored || stored !== JSON.stringify(manifest)) {
    throw new Error('Existing tag artifact manifest differs from the validated packages; refusing unsafe recovery.')
  }
}

export async function publishRelease(cwd, options = {}) {
  validateReleaseOptions(options)
  const { dryRun = false, ui = createReleaseUi({ enabled: false }) } = options
  if (dryRun) {
    return withReleaseDryRun(cwd, { ...options, ui }, (directory, run) =>
      publishInDirectory(directory, { ...options, run, ui }))
  }
  return publishInDirectory(cwd, { ...options, ui })
}

async function publishInDirectory(cwd, { resume = false, dryRun = false, skipValidation = false, skipGitChecks = false, run, ui }) {
  const execute = releaseCommand(cwd, run, ui)
  run ??= liveCommandRunner(cwd)
  const checkCheckout = () => skipGitChecks ? requireDryRunSnapshot(run) : requireCurrentMain(run)
  const commit = await ui.step(skipGitChecks ? 'Checking development snapshot' : dryRun ? 'Checking main and snapshot' : 'Checking clean main and repository', checkCheckout)
  const packages = releasePackages(cwd)
  const version = packages[0].version
  const tag = `v${version}`
  const channel = distTag(version)
  const notes = releaseNotes(cwd, version)
  const ci = await ui.step(skipGitChecks ? 'Checking GitHub and npm access' : 'Checking release commit, GitHub CI and npm access', async () => {
    let ci
    if (skipGitChecks) await checked(run, 'gh', ['auth', 'status'])
    else {
      await requirePreparedCommit(run, packages)
      await requireGitHub(run, repository)
      ci = await requireSuccessfulCi(run, repository, commit, requiredCi)
    }
    await checked(run, 'npm', ['whoami', '--registry', registry])
    return ci
  })
  let state = await tagState(run, tag)
  const published = []
  for (const pkg of packages) published.push(await npmVersion(run, pkg.name, version))
  const release = await githubRelease(run, repository, tag)
  // Development recovery previews may inspect a release whose tag predates the local edits.
  const planCommit = skipGitChecks ? state.remoteCommit || state.localCommit || commit : commit
  const plan = publishPlan({ commit: planCommit, tag: state, packages, published, release, resume })
  ui.note(`Version: ${version}\nCommit: ${commit}\nnpm dist-tag: ${channel}`, resume ? 'Recovery plan' : 'Publication plan')
  if (resume) ui.warn(skipGitChecks
    ? 'Previewing recovery; existing npm versions are checked, tag commit and manifest checks are skipped.'
    : skipValidation ? 'Previewing recovery; existing versions and tag commits are checked, artifact integrity is not verified.'
    : 'Resuming publication; completed release steps will be verified and preserved.')
  if (release && (release.tag_name !== tag || release.prerelease !== (channel !== 'latest'))) {
    throw new Error('Existing GitHub Release does not match this version/channel.')
  }
  if (state.remoteCommit && !state.localCommit) {
    await checked(run, 'git', ['fetch', 'origin', `refs/tags/${tag}:refs/tags/${tag}`])
    state = await tagState(run, tag)
    if (!skipGitChecks && (state.localCommit !== commit || state.remoteCommit !== commit)) {
      throw new Error('Recovery tag changed while fetching; inspect it before retrying.')
    }
  }

  const scratch = skipValidation ? undefined : mkdtempSync(join(tmpdir(), 'better-newsletter-release-'))
  try {
    let artifacts
    let manifest
    if (!skipValidation) {
      await validatePreparation(run, execute)
      await validateArtifacts(run, scratch, execute)
      artifacts = releaseArtifacts(scratch, packages)
      manifest = { commit, packages: artifacts.map(({ name, integrity }) => ({ name, integrity })) }
      for (const [index, existing] of published.entries()) {
        if (existing && existing.dist.integrity !== artifacts[index].integrity) {
          throw new Error(`Published ${packages[index].name}@${version} differs from the validated artifact; never reuse npm versions.`)
        }
      }
      if (!plan.createTag && !skipGitChecks) await verifyTagManifest(run, tag, manifest)
    }

    // Validation may take minutes. Recheck mutable external state before the first mutation.
    if (await checkCheckout() !== commit) throw new Error('HEAD changed during release validation.')
    const freshTag = await tagState(run, tag)
    const freshPublished = []
    for (const pkg of packages) freshPublished.push(await npmVersion(run, pkg.name, version))
    const freshRelease = await githubRelease(run, repository, tag)
    if (JSON.stringify({ tag: freshTag, published: freshPublished, release: freshRelease })
        !== JSON.stringify({ tag: state, published, release })) {
      throw new Error('External release state changed during validation. Inspect it and retry.')
    }
    if (!skipGitChecks) {
      const freshCi = await requireSuccessfulCi(run, repository, commit, requiredCi)
      if (JSON.stringify(freshCi) !== JSON.stringify(ci)) {
        throw new Error('Required CI run changed during validation. Inspect it and retry.')
      }
    }
    if (dryRun) {
      const steps = [
        plan.createTag ? `Create annotated ${tag} on ${commit} ${skipValidation ? 'after validating artifacts' : 'with validated artifact integrities'}`
          : skipGitChecks ? `Keep existing tag ${tag} (tag commit and manifest not verified)`
            : skipValidation ? `Keep existing tag ${tag} (artifact manifest not verified)` : `Keep verified tag ${tag}`,
        plan.pushTag ? `Push ${tag} to origin` : 'Keep the existing remote tag'
      ]
      for (const [index, pkg] of packages.entries()) {
        const missing = plan.packages.some(candidate => candidate.name === pkg.name)
        if (missing && index > 0) steps.push('Verify the matching runtime is visible on npm before publishing the CLI')
        steps.push(missing ? `Publish ${pkg.name}@${version} to ${registry} with dist-tag ${channel}`
          : `Keep ${skipValidation ? 'existing' : 'verified'} ${pkg.name}@${version} on npm${skipValidation ? ' (artifact integrity not verified)' : ''}`)
      }
      steps.push('Verify both npm package integrities after publication',
        plan.createRelease ? `Create GitHub Release ${tag}${channel !== 'latest' ? ' (prerelease)' : ''}` : 'Keep the existing GitHub Release')
      ui.note(steps.join('\n'), 'Would publish')
      ui.preview(notes, 'Release notes preview')
      await requireCleanTree(run)
      return { version, commit, channel, plan, notes,
        ...(skipValidation ? { validationSkipped: true } : { manifest }),
        ...(skipGitChecks ? { gitChecksSkipped: true } : {}) }
    }
    try {
      if (plan.createTag) {
        await ui.step(`Creating annotated tag ${tag}`, () => checked(run, 'git', ['tag', '-a', tag, commit, '-m', `Release ${tag}\n\nRelease-Manifest: ${JSON.stringify(manifest)}`]))
      }
      if (plan.pushTag) await execute('git', ['push', 'origin', `refs/tags/${tag}`],
        { label: `Pushing release tag ${tag}`, completed: `Release tag ${tag} pushed` })
      for (const pkg of plan.packages) {
        const index = packages.findIndex(candidate => candidate.name === pkg.name)
        if (index > 0) {
          const runtime = await npmVersion(run, packages[0].name, version)
          if (!runtime || runtime.dist.integrity !== artifacts[0].integrity) {
            throw new Error('Matching runtime is not visible on npm yet; the CLI will not be published. Wait and resume.')
          }
        }
        if (await npmVersion(run, pkg.name, version)) {
          throw new Error(`${pkg.name}@${version} appeared on npm during publication; inspect it and resume.`)
        }
        await execute('npm', ['publish', artifacts[index].path, '--access', 'public', '--tag', channel,
          '--registry', registry], {
          label: `Publishing ${pkg.name}@${version} with npm dist-tag ${channel}`,
          completed: `${pkg.name}@${version} published`, interactive: true
        })
      }
      for (const [index, pkg] of packages.entries()) {
        const existing = await npmVersion(run, pkg.name, version)
        if (!existing || existing.dist.integrity !== artifacts[index].integrity) {
          throw new Error(`${pkg.name}@${version} is not yet visible with the validated integrity. Wait and resume.`)
        }
      }
      if (plan.createRelease) {
        await execute('gh', ['release', 'create', tag, '--repo', repository, '--verify-tag', '--target', commit,
          '--title', tag, '--notes-file', '-', '--latest=false', ...(channel !== 'latest' ? ['--prerelease'] : [])],
        { label: 'Creating GitHub Release', completed: 'GitHub Release created', input: notes })
      }
      await requireCleanTree(run)
      ui.success(`Released ${tag}`)
      ui.finish(`https://github.com/${repository}/releases/tag/${tag}`)
    } catch (error) {
      throw new Error(`Release interrupted. Keep any valid tag and published npm versions. Inspect remote state, then run pnpm release:publish --resume on this exact main commit.`, { cause: error })
    }
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true })
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await runReleaseCli('publish', ({ resume, dryRun, skipValidation, skipGitChecks, ui }) => publishRelease(process.cwd(), { resume, dryRun, skipValidation, skipGitChecks, ui }))
}
