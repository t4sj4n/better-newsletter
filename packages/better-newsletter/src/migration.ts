export interface MigrationPlan {
  readonly dialect: string
  readonly namespace: string
  readonly toBeCreated: readonly string[]
  readonly toBeAdded: readonly string[]
  readonly statements: readonly string[]
  readonly sql: string
  readonly isCurrent: boolean
}

export interface MigrationProvider {
  readonly dialect: string
  plan(): Promise<MigrationPlan>
  apply(plan: MigrationPlan): Promise<void>
}

export interface BetterNewsletterMigrationConfig {
  readonly provider: MigrationProvider
  /**
   * Optional host-owned cleanup for CLI usage, for example `db.destroy()`.
   * The provider never destroys a host database connection implicitly.
   */
  readonly close?: () => void | Promise<void>
}

export interface NewsletterMigrations extends MigrationPlan {
  runMigrations(): Promise<void>
}

export function defineBetterNewsletterMigrationConfig<
  T extends BetterNewsletterMigrationConfig
>(config: T): T {
  return config
}

export async function getMigrations(
  config: BetterNewsletterMigrationConfig
): Promise<NewsletterMigrations> {
  const plan = await config.provider.plan()
  return {
    ...plan,
    async runMigrations() {
      if (plan.isCurrent) return
      await config.provider.apply(plan)
    }
  }
}
