import console from 'node:console'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { checked, commandRunner, distTag, githubRelease, npmVersion, publishPlan, registry, requireCleanTree, requireCurrentMain, requireGitHub, requireSuccessfulCi, tagState } from './release-core.mjs'
import { releaseArtifacts, releaseNotes, releasePackages, repository, requiredCi, requirePreparedCommit, validateArtifacts, validatePreparation } from './release-policy.mjs'

function verifyTagManifest(run, tag, manifest) {
  if (checked(run, 'git', ['cat-file', '-t', `refs/tags/${tag}`]) !== 'tag') {
    throw new Error('Recovery requires the annotated tag created by release:publish.')
  }
  const annotation = checked(run, 'git', ['cat-file', '-p', `refs/tags/${tag}`])
  const stored = /^Release-Manifest: (.+)$/mu.exec(annotation)?.[1]
  if (!stored || stored !== JSON.stringify(manifest)) {
    throw new Error('Existing tag artifact manifest differs from the validated packages; refusing unsafe recovery.')
  }
}

export function publishRelease(cwd, { resume = false, run = commandRunner(cwd) } = {}) {
  const commit = requireCurrentMain(run)
  const packages = releasePackages(cwd)
  const version = packages[0].version
  const tag = `v${version}`
  const channel = distTag(version)
  const notes = releaseNotes(cwd, version)
  requirePreparedCommit(run, packages)
  requireGitHub(run, repository)
  const ci = requireSuccessfulCi(run, repository, commit, requiredCi)
  checked(run, 'npm', ['whoami', '--registry', registry])
  let state = tagState(run, tag)
  const published = packages.map(pkg => npmVersion(run, pkg.name, version))
  const release = githubRelease(run, repository, tag)
  const plan = publishPlan({ commit, tag: state, packages, published, release, resume })
  if (release && (release.tag_name !== tag || release.prerelease !== (channel !== 'latest'))) {
    throw new Error('Existing GitHub Release does not match this version/channel.')
  }
  if (state.remoteCommit && !state.localCommit) {
    checked(run, 'git', ['fetch', 'origin', `refs/tags/${tag}:refs/tags/${tag}`])
    state = tagState(run, tag)
    if (state.localCommit !== commit || state.remoteCommit !== commit) {
      throw new Error('Recovery tag changed while fetching; inspect it before retrying.')
    }
  }

  const scratch = mkdtempSync(join(tmpdir(), 'better-newsletter-release-'))
  try {
    console.log(`Validating ${tag} on ${commit} (npm dist-tag: ${channel})...`)
    validatePreparation(run)
    validateArtifacts(run, scratch)
    const artifacts = releaseArtifacts(scratch, packages)
    const manifest = { commit, packages: artifacts.map(({ name, integrity }) => ({ name, integrity })) }
    for (const [index, existing] of published.entries()) {
      if (existing && existing.dist.integrity !== artifacts[index].integrity) {
        throw new Error(`Published ${packages[index].name}@${version} differs from the validated artifact; never reuse npm versions.`)
      }
    }
    if (!plan.createTag) verifyTagManifest(run, tag, manifest)

    // Validation may take minutes. Recheck mutable external state before the first mutation.
    if (requireCurrentMain(run) !== commit) throw new Error('HEAD changed during release validation.')
    const freshTag = tagState(run, tag)
    const freshPublished = packages.map(pkg => npmVersion(run, pkg.name, version))
    const freshRelease = githubRelease(run, repository, tag)
    if (JSON.stringify({ tag: freshTag, published: freshPublished, release: freshRelease })
        !== JSON.stringify({ tag: state, published, release })) {
      throw new Error('External release state changed during validation. Inspect it and retry.')
    }
    const freshCi = requireSuccessfulCi(run, repository, commit, requiredCi)
    if (JSON.stringify(freshCi) !== JSON.stringify(ci)) {
      throw new Error('Required CI run changed during validation. Inspect it and retry.')
    }
    try {
      if (plan.createTag) {
        checked(run, 'git', ['tag', '-a', tag, commit, '-m', `Release ${tag}\n\nRelease-Manifest: ${JSON.stringify(manifest)}`])
      }
      if (plan.pushTag) checked(run, 'git', ['push', 'origin', `refs/tags/${tag}`])
      for (const pkg of plan.packages) {
        const index = packages.findIndex(candidate => candidate.name === pkg.name)
        if (index > 0) {
          const runtime = npmVersion(run, packages[0].name, version)
          if (!runtime || runtime.dist.integrity !== artifacts[0].integrity) {
            throw new Error('Matching runtime is not visible on npm yet; the CLI will not be published. Wait and resume.')
          }
        }
        if (npmVersion(run, pkg.name, version)) {
          throw new Error(`${pkg.name}@${version} appeared on npm during publication; inspect it and resume.`)
        }
        console.log(`Publishing ${pkg.name}@${version} with --tag ${channel}...`)
        checked(run, 'npm', ['publish', artifacts[index].path, '--access', 'public', '--tag', channel,
          '--registry', registry], { stdio: 'inherit' })
      }
      for (const [index, pkg] of packages.entries()) {
        const existing = npmVersion(run, pkg.name, version)
        if (!existing || existing.dist.integrity !== artifacts[index].integrity) {
          throw new Error(`${pkg.name}@${version} is not yet visible with the validated integrity. Wait and resume.`)
        }
      }
      if (plan.createRelease) {
        checked(run, 'gh', ['release', 'create', tag, '--repo', repository, '--verify-tag', '--target', commit,
          '--title', tag, '--notes-file', '-', '--latest=false', ...(channel !== 'latest' ? ['--prerelease'] : [])],
        { input: notes })
      }
      requireCleanTree(run)
      console.log(`Released ${tag}: https://github.com/${repository}/releases/tag/${tag}`)
    } catch (error) {
      throw new Error(`Release interrupted. Keep any valid tag and published npm versions. Inspect remote state, then run pnpm release:publish --resume on this exact main commit.`, { cause: error })
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2)
  if (args.length > 1 || (args.length === 1 && args[0] !== '--resume')) {
    throw new Error('Usage: pnpm release:publish [--resume]')
  }
  publishRelease(process.cwd(), { resume: args[0] === '--resume' })
}
