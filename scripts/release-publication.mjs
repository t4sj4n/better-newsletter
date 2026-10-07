import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, isAbsolute, join, resolve } from 'node:path'
import process from 'node:process'
import { checked, githubRelease, npmVersion, publishPlan, requireCleanTree, requireMainCommit, requireSuccessfulCi, tagState } from './release-core.mjs'
import { releaseArtifacts, releasePackages, repository, requiredCi } from './release-policy.mjs'

export async function artifactDirectory(cwd, run, version) {
  const path = await checked(run, 'git', ['rev-parse', '--git-path', `newsletter-releases/${version}`])
  return isAbsolute(path) ? path : resolve(cwd, path)
}

export async function publicationState(run, packages, commit, resume) {
  const version = packages[0].version
  const tag = await tagState(run, `v${version}`)
  const published = []
  for (const pkg of packages) published.push(await npmVersion(run, pkg.name, version))
  const release = await githubRelease(run, repository, `v${version}`)
  if (release && (release.tag_name !== `v${version}` || release.prerelease !== version.includes('-'))) {
    throw new Error('Existing GitHub Release does not match this version/channel.')
  }
  return { tag, published, release, plan: publishPlan({ commit, tag, packages, published, release, resume }) }
}

function signature(state) {
  return JSON.stringify({ tag: state.tag, published: state.published.map(pkg => pkg?.dist.integrity ?? null), release: state.release })
}

export async function verifyManifest(run, version, manifest) {
  const ref = `refs/tags/v${version}`
  if (await checked(run, 'git', ['cat-file', '-t', ref]) !== 'tag') {
    throw new Error('Recovery requires the annotated release tag with its artifact manifest.')
  }
  const annotation = await checked(run, 'git', ['cat-file', '-p', ref])
  const stored = /^Release-Manifest: (.+)$/mu.exec(annotation)?.[1]
  if (stored !== JSON.stringify(manifest)) throw new Error('Release tag artifact manifest differs from the validated packages.')
}

export async function preparePublication(cwd, { run, resume = false }) {
  const commit = await requireMainCommit(run)
  const packages = releasePackages(cwd)
  const version = packages[0].version
  const state = await publicationState(run, packages, commit, resume)
  await requireSuccessfulCi(run, repository, commit, requiredCi)
  if (state.tag.remoteCommit && !state.tag.localCommit) {
    await checked(run, 'git', ['fetch', 'origin', `refs/tags/v${version}:refs/tags/v${version}`])
    state.tag = await tagState(run, `v${version}`)
  }
  const directory = await artifactDirectory(cwd, run, version)
  const path = join(directory, 'manifest.json')
  mkdirSync(directory, { recursive: true })
  let manifest
  if (resume && existsSync(path)) {
    manifest = JSON.parse(readFileSync(path, 'utf8'))
  } else {
    const staging = mkdtempSync(join(directory, 'packing-'))
    try {
      await checked(run, 'pnpm', ['install', '--frozen-lockfile'])
      await checked(run, 'node', ['scripts/smoke-pack.mjs', '--pack-destination', staging], {
        env: { ...process.env, DATABASE_URL: '' }
      })
      for (const artifact of releaseArtifacts(staging, packages)) {
        copyFileSync(artifact.path, join(directory, basename(artifact.path)))
      }
    } finally {
      rmSync(staging, { recursive: true, force: true })
    }
  }
  const artifacts = releaseArtifacts(directory, packages)
  const actual = { commit, packages: artifacts.map(({ name, integrity }) => ({ name, integrity })) }
  if (manifest && JSON.stringify(manifest) !== JSON.stringify(actual)) {
    throw new Error('Cached release artifacts differ from their manifest or selected commit; inspect them before retrying.')
  }
  manifest = actual
  for (const [index, pkg] of state.published.entries()) {
    if (pkg && pkg.dist.integrity !== artifacts[index].integrity) {
      throw new Error(`Published ${packages[index].name}@${version} differs from the validated artifact; never reuse npm versions.`)
    }
  }
  if (!state.plan.createTag) await verifyManifest(run, version, manifest)
  // Accept a new green CI run for the same SHA; pending or failed reruns still block.
  await requireSuccessfulCi(run, repository, commit, requiredCi)
  if (await requireMainCommit(run) !== commit
      || signature(await publicationState(run, packages, commit, resume)) !== signature(state)) {
    throw new Error('Release commit or external publication state changed during validation; inspect it and retry.')
  }
  writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n')
  return { ...state, commit, packages, artifacts, manifest, directory }
}

/** Publish only the exact checked tarballs; never rebuild or republish an existing version. */
export async function publishPackages(run, { packages, artifacts, plan, channel }) {
  for (const pkg of plan.packages) {
    const index = packages.findIndex(candidate => candidate.name === pkg.name)
    if (index > 0) {
      const runtime = await npmVersion(run, packages[0].name, packages[0].version)
      if (runtime?.dist.integrity !== artifacts[0].integrity) {
        throw new Error('Matching runtime is not visible on npm yet; wait and resume before publishing the CLI.')
      }
    }
    if (await npmVersion(run, pkg.name, pkg.version)) {
      throw new Error(`${pkg.name}@${pkg.version} appeared during publication; inspect it and resume.`)
    }
    await checked(run, 'npm', ['publish', artifacts[index].path, '--access', 'public', '--tag', channel,
      '--registry', 'https://registry.npmjs.org'], { interactive: true })
  }
  await verifyPublishedPackages(run, packages, artifacts)
}

export async function verifyPublishedPackages(run, packages, artifacts) {
  for (const [index, pkg] of packages.entries()) {
    const existing = await npmVersion(run, pkg.name, pkg.version)
    if (existing?.dist.integrity !== artifacts[index].integrity) {
      throw new Error(`${pkg.name}@${pkg.version} is not visible with the validated integrity; wait and resume.`)
    }
  }
}

export async function removeArtifacts(cwd, run, version) {
  await requireCleanTree(run)
  rmSync(await artifactDirectory(cwd, run, version), { recursive: true, force: true })
}
