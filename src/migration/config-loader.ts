import { existsSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { createJiti } from 'jiti'
import type { BetterNewsletterMigrationConfig } from '../migration.js'

const defaultConfigFiles = [
  'better-newsletter.config.ts',
  'better-newsletter.config.mts',
  'better-newsletter.config.js',
  'better-newsletter.config.mjs',
  'server/better-newsletter.config.ts',
  'server/better-newsletter.config.mts',
  'server/better-newsletter.config.js',
  'server/better-newsletter.config.mjs'
] as const

export interface LoadMigrationConfigOptions {
  readonly cwd: string
  readonly configFile?: string
}

export interface LoadedMigrationConfig {
  readonly config: BetterNewsletterMigrationConfig
  readonly path: string
}

function isMigrationConfig(value: unknown): value is BetterNewsletterMigrationConfig {
  if (value == null || typeof value !== 'object') return false
  const provider = (value as { provider?: unknown }).provider
  return provider != null
    && typeof provider === 'object'
    && typeof (provider as { plan?: unknown }).plan === 'function'
    && typeof (provider as { apply?: unknown }).apply === 'function'
}

function resolveConfigPath(options: LoadMigrationConfigOptions): string {
  if (options.configFile != null) {
    const path = isAbsolute(options.configFile)
      ? options.configFile
      : resolve(options.cwd, options.configFile)
    if (!existsSync(path)) {
      throw new Error(`Better Newsletter migration config not found: ${path}`)
    }
    return path
  }

  for (const candidate of defaultConfigFiles) {
    const path = resolve(options.cwd, candidate)
    if (existsSync(path)) return path
  }

  throw new Error(
    'Better Newsletter migration config not found. '
    + 'Create better-newsletter.config.ts, export a named "migration" config '
    + 'from server/better-newsletter.config.ts, or pass --config.'
  )
}

export async function loadMigrationConfig(
  options: LoadMigrationConfigOptions
): Promise<LoadedMigrationConfig> {
  const path = resolveConfigPath(options)
  const jiti = createJiti(import.meta.url)
  const module = await jiti.import(path) as Record<string, unknown>
  const candidate = await Promise.resolve(module.migration ?? module.default)

  if (!isMigrationConfig(candidate)) {
    throw new Error(
      `No Better Newsletter migration config was exported from ${path}. `
      + 'Export a named "migration" value created with '
      + 'defineBetterNewsletterMigrationConfig().'
    )
  }

  return { config: candidate, path }
}
