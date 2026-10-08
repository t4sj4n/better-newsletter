#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { versionBump } from 'bumpp'
import semver from 'semver'
import { updateChangelog } from './release-notes.mjs'
import { runScriptCli } from './script-cli.mjs'

/**
 * Interactive local release command using Clack UI, bumpp, and changelogen.
 * Bumps packages/better-newsletter, packages/cli, synchronizes the CLI workspace dependency,
 * updates CHANGELOG.md, commits, tags, and guides pushing to remote.
 */
export async function runRelease({ cwd = process.cwd(), releaseArg, ui } = {}) {
  const run = (command, args, capture = false) => execFileSync(command, args, {
    cwd, ...(capture ? { encoding: 'utf8' } : { stdio: 'inherit' })
  })

  let runtimePkg
  let cliPkg
  let currentVersion

  const runtimePkgPath = join(cwd, 'packages/better-newsletter/package.json')
  const cliPkgPath = join(cwd, 'packages/cli/package.json')

  if (ui) {
    await ui.step('Verifying git working tree and package synchronization', async () => {
      const branch = run('git', ['branch', '--show-current'], true).trim()
      if (branch !== 'main') {
        throw new Error(`Releases must be prepared directly on 'main' (current branch: '${branch}').`)
      }

      const status = run('git', ['status', '--porcelain'], true).trim()
      if (status) {
        throw new Error('Working directory must be clean before creating a release.')
      }

      runtimePkg = JSON.parse(readFileSync(runtimePkgPath, 'utf8'))
      cliPkg = JSON.parse(readFileSync(cliPkgPath, 'utf8'))

      if (runtimePkg.version !== cliPkg.version) {
        throw new Error(`Runtime (${runtimePkg.version}) and CLI (${cliPkg.version}) versions must already be synchronized.`)
      }

      currentVersion = runtimePkg.version
    })
  } else {
    const branch = run('git', ['branch', '--show-current'], true).trim()
    if (branch !== 'main') {
      throw new Error(`Releases must be prepared directly on 'main' (current branch: '${branch}').`)
    }
    const status = run('git', ['status', '--porcelain'], true).trim()
    if (status) {
      throw new Error('Working directory must be clean before creating a release.')
    }
    runtimePkg = JSON.parse(readFileSync(runtimePkgPath, 'utf8'))
    cliPkg = JSON.parse(readFileSync(cliPkgPath, 'utf8'))
    if (runtimePkg.version !== cliPkg.version) {
      throw new Error(`Runtime (${runtimePkg.version}) and CLI (${cliPkg.version}) versions must already be synchronized.`)
    }
    currentVersion = runtimePkg.version
  }

  // Interactive version selection and file update via bumpp
  const bumpResult = await versionBump({
    cwd,
    release: releaseArg,
    currentVersion,
    files: [
      'packages/better-newsletter/package.json',
      'packages/cli/package.json'
    ],
    commit: false,
    tag: false,
    push: false,
    noGitCheck: true
  })

  const newVersion = bumpResult.newVersion
  if (!newVersion || !semver.valid(newVersion)) {
    throw new Error(`Invalid version: '${newVersion}'.`)
  }

  const existingTag = run('git', ['tag', '-l', `v${newVersion}`], true).trim()
  if (existingTag) {
    throw new Error(`Git tag 'v${newVersion}' already exists. Choose a new version or remove the tag first.`)
  }

  // Synchronize CLI workspace dependency and lockfile
  if (ui) {
    await ui.step(`Synchronizing CLI dependency and updating lockfile for v${newVersion}`, async () => {
      const updatedCliPkg = JSON.parse(readFileSync(cliPkgPath, 'utf8'))
      updatedCliPkg.dependencies['better-newsletter'] = `workspace:${newVersion}`
      writeFileSync(cliPkgPath, `${JSON.stringify(updatedCliPkg, null, 2)}\n`)
      run('pnpm', ['install', '--lockfile-only', '--ignore-scripts'])
    })

    await ui.step(`Generating release notes in CHANGELOG.md for v${newVersion}`, async () => {
      await updateChangelog(cwd, newVersion)
    })

    await ui.step(`Creating release commit and tag v${newVersion}`, async () => {
      run('git', ['add', 'packages/better-newsletter/package.json', 'packages/cli/package.json', 'pnpm-lock.yaml', 'CHANGELOG.md'])
      const commitMessage = `🔖 Release v${newVersion}`
      run('git', ['commit', '-m', commitMessage])
      run('git', ['tag', '-a', `v${newVersion}`, '-m', `v${newVersion}`])
    })

    ui.finish(`Created release commit and tag v${newVersion}. Push to trigger publication:\n\n  git push origin main --follow-tags`)
  } else {
    const updatedCliPkg = JSON.parse(readFileSync(cliPkgPath, 'utf8'))
    updatedCliPkg.dependencies['better-newsletter'] = `workspace:${newVersion}`
    writeFileSync(cliPkgPath, `${JSON.stringify(updatedCliPkg, null, 2)}\n`)
    run('pnpm', ['install', '--lockfile-only', '--ignore-scripts'])
    await updateChangelog(cwd, newVersion)
    run('git', ['add', 'packages/better-newsletter/package.json', 'packages/cli/package.json', 'pnpm-lock.yaml', 'CHANGELOG.md'])
    run('git', ['commit', '-m', `🔖 Release v${newVersion}`])
    run('git', ['tag', '-a', `v${newVersion}`, '-m', `v${newVersion}`])
  }
}

if (process.argv[1] && process.argv[1].endsWith('release.mjs')) {
  await runScriptCli({
    title: 'release',
    parseArgs: args => ({ releaseArg: args[0] })
  }, async ({ releaseArg, ui }) => {
    await runRelease({ cwd: process.cwd(), releaseArg, ui })
  })
}
