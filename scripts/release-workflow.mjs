import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { Plugin } from 'release-it'
import semver from 'semver'
import { checked, createReleaseBranch, distTag, liveCommandRunner, npmVersion, registry, requireCurrentMain, requireGitHub, requireMainCommit, requireSuccessfulCi, tagState } from './release-core.mjs'
import { updateChangelog } from './release-notes.mjs'
import { releaseNotes, releasePackages, releasePaths, repository, requiredCi, requireReleaseCommit } from './release-policy.mjs'
import { conciseMessage } from './script-errors.mjs'
import { preparePublication } from './release-publication.mjs'

/** Keep repository-specific checks inside release-it's native lifecycle and rendering. */
export default class ReleaseWorkflow extends Plugin {
  async init() {
    this.cwd = process.cwd()
    const runner = liveCommandRunner(this.cwd)
    this.run = async (command, args, options) => {
      const result = await runner(command, args, { onOutput: line => this.log.verbose(line, { isExternal: true }), ...options })
      return result.status && !this.config.isVerbose
        ? { ...result, stdout: conciseMessage(result.stdout), stderr: conciseMessage(result.stderr) } : result
    }
    this.packages = releasePackages(this.cwd)
    if (this.config.isDryRun) {
      this.log.warn('Preview only: Git release prerequisites, authentication, CI and artifact validation are skipped. No release readiness is established.')
      return
    }
    this.commit = this.options.kind === 'prepare'
      ? await requireCurrentMain(this.run) : await requireMainCommit(this.run)
    await requireGitHub(this.run, repository)
    if (this.options.kind === 'publish') {
      await requireReleaseCommit(this.run, this.packages)
      await requireSuccessfulCi(this.run, repository, this.commit, requiredCi)
      await checked(this.run, 'npm', ['whoami', '--registry', registry])
    }
  }

  async beforeBump() {
    if (this.options.kind !== 'prepare') return
    const version = this.config.getContext('version')
    distTag(version)
    if (this.options.increment === 'prerelease' && !this.packages[0].version.includes('-')) {
      throw new Error('prerelease requires an existing channel; choose an explicit alpha, beta or rc version.')
    }
    if (semver.compare(version, this.packages[0].version) <= 0) throw new Error('Choose a version newer than the current version.')
    const branch = `release/v${version}`
    if (this.config.isDryRun) {
      this.log.exec(`git switch -c ${branch}`, { isDryRun: true })
      return
    }
    const tag = await tagState(this.run, `v${version}`)
    if (tag.localCommit || tag.remoteCommit) throw new Error(`Tag v${version} already exists.`)
    for (const pkg of this.packages) {
      if (await npmVersion(this.run, pkg.name, version)) throw new Error(`${pkg.name}@${version} is already published.`)
    }
    await createReleaseBranch(this.run, branch)
  }

  async bump(version) {
    if (this.options.kind !== 'prepare' || this.config.isDryRun) return
    await this.spinner.show({ label: 'Updating dependency, lockfile and release notes', external: true, task: async () => {
      const path = join(this.cwd, 'packages/cli/package.json')
      const cli = JSON.parse(readFileSync(path, 'utf8'))
      cli.dependencies['better-newsletter'] = `workspace:${version}`
      writeFileSync(path, JSON.stringify(cli, null, 2) + '\n')
      await checked(this.run, 'pnpm', ['install', '--lockfile-only', '--ignore-scripts'])
      await updateChangelog(this.cwd, version)
    } })
  }

  async beforeRelease() {
    if (this.config.isDryRun) return
    if (this.options.kind === 'prepare') {
      const version = this.config.getContext('version')
      releaseNotes(this.cwd, version)
      releasePackages(this.cwd)
      const changes = (await checked(this.run, 'git', ['status', '--porcelain'])).split('\n').filter(Boolean)
      if (changes.some(line => !releasePaths.includes(line.slice(3)))
          || await checked(this.run, 'git', ['rev-parse', 'HEAD']) !== this.commit) {
        throw new Error('Unexpected checkout changes during preparation; inspect the release branch before committing.')
      }
      return
    }
    const state = await this.spinner.show({ label: 'Checking publication state and packed artifacts', external: true,
      task: () => preparePublication(this.cwd, { run: this.run, resume: this.options.resume }) })
    this.config.setContext({ releaseManifest: JSON.stringify(state.manifest) })
  }
}
