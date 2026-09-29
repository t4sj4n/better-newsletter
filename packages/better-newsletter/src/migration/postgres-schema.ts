export interface PostgresSchemaColumn {
  readonly name: string
  readonly definition: string
}

export interface PostgresSchemaConstraint {
  readonly name: string
  readonly definition: string
}

export interface PostgresSchemaTable {
  readonly name: string
  readonly columns: readonly PostgresSchemaColumn[]
  readonly constraints: readonly PostgresSchemaConstraint[]
}

export interface PostgresSchemaIndex {
  readonly name: string
  readonly table: string
  readonly definition: string
}

export interface PostgresSchemaModel {
  readonly version: number
  readonly tables: readonly PostgresSchemaTable[]
  readonly indexes: readonly PostgresSchemaIndex[]
}

/**
 * Canonical PostgreSQL target schema. Additive planning, the packaged SQL
 * snapshot, CLI generation and direct migration all derive from this model.
 */
export const POSTGRES_NEWSLETTER_SCHEMA: PostgresSchemaModel = Object.freeze({
  version: 1,
  tables: [
    {
      name: 'newsletter_contacts',
      columns: [
        { name: 'id', definition: 'text NOT NULL' },
        { name: 'capability_generation', definition: 'bigint NOT NULL DEFAULT 1' },
        { name: 'email', definition: 'text NOT NULL' },
        { name: 'status', definition: 'text NOT NULL' },
        { name: 'subject_namespace', definition: 'text' },
        { name: 'subject_id', definition: 'text' },
        { name: 'metadata', definition: "jsonb NOT NULL DEFAULT '{}'::jsonb" },
        { name: 'suppressed_at', definition: 'timestamptz' },
        { name: 'suppression_reason', definition: 'text' },
        { name: 'created_at', definition: 'timestamptz NOT NULL' },
        { name: 'updated_at', definition: 'timestamptz NOT NULL' }
      ],
      constraints: [
        { name: 'newsletter_contacts_pkey', definition: 'PRIMARY KEY (id)' },
        {
          name: 'newsletter_contacts_capability_generation_check',
          definition: 'CHECK (capability_generation > 0)'
        },
        { name: 'newsletter_contacts_email_key', definition: 'UNIQUE (email)' },
        {
          name: 'newsletter_contacts_email_check',
          definition: 'CHECK (email = lower(btrim(email)) AND length(email) BETWEEN 1 AND 254)'
        },
        {
          name: 'newsletter_contacts_status_check',
          definition: "CHECK (status IN ('ENABLED', 'SUPPRESSED'))"
        },
        {
          name: 'newsletter_contacts_metadata_check',
          definition: "CHECK (jsonb_typeof(metadata) = 'object')"
        },
        {
          name: 'newsletter_contacts_subject_pair',
          definition: `CHECK (
    (subject_namespace IS NULL AND subject_id IS NULL)
    OR (subject_namespace IS NOT NULL AND subject_id IS NOT NULL)
  )`
        }
      ]
    },
    {
      name: 'newsletter_subscriptions',
      columns: [
        { name: 'id', definition: 'text NOT NULL' },
        { name: 'contact_id', definition: 'text NOT NULL' },
        { name: 'audience_key', definition: 'text NOT NULL' },
        { name: 'lifecycle_generation', definition: 'bigint NOT NULL DEFAULT 1' },
        { name: 'status', definition: 'text NOT NULL' },
        { name: 'consent_version', definition: 'text NOT NULL' },
        { name: 'consent_source', definition: 'text' },
        { name: 'consent_locale', definition: 'text' },
        { name: 'consented_at', definition: 'timestamptz NOT NULL' },
        { name: 'confirmation_delivery_id', definition: 'text' },
        { name: 'confirmation_attempt_id', definition: 'text' },
        { name: 'confirmation_lease_expires_at', definition: 'timestamptz' },
        { name: 'confirmation_sent_at', definition: 'timestamptz' },
        { name: 'confirmed_at', definition: 'timestamptz' },
        { name: 'unsubscribed_at', definition: 'timestamptz' },
        { name: 'created_at', definition: 'timestamptz NOT NULL' },
        { name: 'updated_at', definition: 'timestamptz NOT NULL' }
      ],
      constraints: [
        { name: 'newsletter_subscriptions_pkey', definition: 'PRIMARY KEY (id)' },
        {
          name: 'newsletter_subscriptions_contact_id_fkey',
          definition: 'FOREIGN KEY (contact_id) REFERENCES newsletter_contacts (id) ON DELETE CASCADE'
        },
        {
          name: 'newsletter_subscriptions_audience_key_check',
          definition: 'CHECK (audience_key = btrim(audience_key) AND length(audience_key) BETWEEN 1 AND 128)'
        },
        {
          name: 'newsletter_subscriptions_lifecycle_generation_check',
          definition: 'CHECK (lifecycle_generation > 0)'
        },
        {
          name: 'newsletter_subscriptions_status_check',
          definition: "CHECK (status IN ('PENDING_CONFIRMATION', 'ACTIVE', 'UNSUBSCRIBED'))"
        },
        {
          name: 'newsletter_subscriptions_contact_audience_key',
          definition: 'UNIQUE (contact_id, audience_key)'
        },
        {
          name: 'newsletter_subscriptions_delivery_claim',
          definition: `CHECK (
    (confirmation_delivery_id IS NULL
      AND confirmation_attempt_id IS NULL
      AND confirmation_lease_expires_at IS NULL)
    OR (confirmation_delivery_id IS NOT NULL
      AND (confirmation_attempt_id IS NULL) = (confirmation_lease_expires_at IS NULL))
  )`
        }
      ]
    },
    {
      name: 'newsletter_tokens',
      columns: [
        { name: 'id', definition: 'bigint GENERATED ALWAYS AS IDENTITY NOT NULL' },
        { name: 'digest', definition: 'text NOT NULL' },
        { name: 'purpose', definition: 'text NOT NULL' },
        { name: 'contact_id', definition: 'text NOT NULL' },
        { name: 'subscription_id', definition: 'text NOT NULL' },
        { name: 'lifecycle_generation', definition: 'bigint NOT NULL' },
        { name: 'created_at', definition: 'timestamptz NOT NULL' },
        { name: 'expires_at', definition: 'timestamptz NOT NULL' },
        { name: 'consumed_at', definition: 'timestamptz' },
        { name: 'revoked_at', definition: 'timestamptz' }
      ],
      constraints: [
        { name: 'newsletter_tokens_pkey', definition: 'PRIMARY KEY (id)' },
        { name: 'newsletter_tokens_digest_key', definition: 'UNIQUE (digest)' },
        {
          name: 'newsletter_tokens_purpose_check',
          definition: "CHECK (purpose = 'CONFIRMATION')"
        },
        {
          name: 'newsletter_tokens_contact_id_fkey',
          definition: 'FOREIGN KEY (contact_id) REFERENCES newsletter_contacts (id) ON DELETE CASCADE'
        },
        {
          name: 'newsletter_tokens_subscription_id_fkey',
          definition: 'FOREIGN KEY (subscription_id) REFERENCES newsletter_subscriptions (id) ON DELETE CASCADE'
        },
        {
          name: 'newsletter_tokens_lifecycle_generation_check',
          definition: 'CHECK (lifecycle_generation > 0)'
        },
        {
          name: 'newsletter_tokens_expiry',
          definition: 'CHECK (expires_at > created_at)'
        }
      ]
    },
    {
      name: 'newsletter_events',
      columns: [
        { name: 'id', definition: 'text NOT NULL' },
        { name: 'sequence', definition: 'bigint GENERATED ALWAYS AS IDENTITY NOT NULL' },
        { name: 'contact_id', definition: 'text NOT NULL' },
        { name: 'subscription_id', definition: 'text' },
        { name: 'event_type', definition: 'text NOT NULL' },
        { name: 'occurred_at', definition: 'timestamptz NOT NULL' },
        { name: 'metadata', definition: "jsonb NOT NULL DEFAULT '{}'::jsonb" }
      ],
      constraints: [
        { name: 'newsletter_events_pkey', definition: 'PRIMARY KEY (id)' },
        { name: 'newsletter_events_sequence_key', definition: 'UNIQUE (sequence)' },
        {
          name: 'newsletter_events_contact_id_fkey',
          definition: 'FOREIGN KEY (contact_id) REFERENCES newsletter_contacts (id) ON DELETE CASCADE'
        },
        {
          name: 'newsletter_events_subscription_id_fkey',
          definition: 'FOREIGN KEY (subscription_id) REFERENCES newsletter_subscriptions (id) ON DELETE CASCADE'
        },
        {
          name: 'newsletter_events_event_type_check',
          definition: "CHECK (event_type <> '')"
        },
        {
          name: 'newsletter_events_metadata_check',
          definition: "CHECK (jsonb_typeof(metadata) = 'object')"
        }
      ]
    },
    {
      name: 'newsletter_rate_limits',
      columns: [
        { name: 'key_hash', definition: 'text NOT NULL' },
        { name: 'action', definition: 'text NOT NULL' },
        { name: 'window_ms', definition: 'bigint NOT NULL' },
        { name: 'bucket_start_ms', definition: 'bigint NOT NULL' },
        { name: 'expires_at', definition: 'timestamptz NOT NULL' },
        { name: 'attempt_count', definition: 'integer NOT NULL' }
      ],
      constraints: [
        {
          name: 'newsletter_rate_limits_pkey',
          definition: 'PRIMARY KEY (key_hash, action, window_ms, bucket_start_ms)'
        },
        {
          name: 'newsletter_rate_limits_key_hash_check',
          definition: "CHECK (key_hash <> '')"
        },
        {
          name: 'newsletter_rate_limits_action_check',
          definition: "CHECK (action <> '')"
        },
        {
          name: 'newsletter_rate_limits_window_ms_check',
          definition: 'CHECK (window_ms > 0)'
        },
        {
          name: 'newsletter_rate_limits_bucket_start_ms_check',
          definition: 'CHECK (bucket_start_ms >= 0)'
        },
        {
          name: 'newsletter_rate_limits_attempt_count_check',
          definition: 'CHECK (attempt_count > 0)'
        }
      ]
    }
  ],
  indexes: [
    {
      name: 'newsletter_subscriptions_eligible_idx',
      table: 'newsletter_subscriptions',
      definition: "ON newsletter_subscriptions (audience_key, contact_id) WHERE status = 'ACTIVE' AND confirmed_at IS NOT NULL AND unsubscribed_at IS NULL"
    },
    {
      name: 'newsletter_tokens_subscription_generation_retention_idx',
      table: 'newsletter_tokens',
      definition: 'ON newsletter_tokens (subscription_id, lifecycle_generation, created_at DESC, id DESC)'
    },
    {
      name: 'newsletter_tokens_contact_id_idx',
      table: 'newsletter_tokens',
      definition: 'ON newsletter_tokens (contact_id)'
    },
    {
      name: 'newsletter_tokens_expires_at_idx',
      table: 'newsletter_tokens',
      definition: 'ON newsletter_tokens (expires_at)'
    },
    {
      name: 'newsletter_tokens_cleanup_idx',
      table: 'newsletter_tokens',
      definition: 'ON newsletter_tokens (COALESCE(consumed_at, revoked_at, expires_at))'
    },
    {
      name: 'newsletter_events_contact_sequence_idx',
      table: 'newsletter_events',
      definition: 'ON newsletter_events (contact_id, sequence)'
    },
    {
      name: 'newsletter_events_subscription_sequence_idx',
      table: 'newsletter_events',
      definition: 'ON newsletter_events (subscription_id, sequence) WHERE subscription_id IS NOT NULL'
    },
    {
      name: 'newsletter_rate_limits_expires_at_idx',
      table: 'newsletter_rate_limits',
      definition: 'ON newsletter_rate_limits (expires_at)'
    }
  ]
})

export function renderPostgresCreateTable(table: PostgresSchemaTable): string {
  const entries = [
    ...table.columns.map(column => `  ${column.name} ${column.definition}`),
    ...table.constraints.map(constraint =>
      `  CONSTRAINT ${constraint.name} ${constraint.definition}`
    )
  ]
  return `CREATE TABLE ${table.name} (\n${entries.join(',\n')}\n)`
}

export function renderPostgresAddColumn(
  table: PostgresSchemaTable,
  column: PostgresSchemaColumn
): string {
  return `ALTER TABLE ${table.name} ADD COLUMN ${column.name} ${column.definition}`
}

export function renderPostgresAddConstraint(
  table: PostgresSchemaTable,
  constraint: PostgresSchemaConstraint
): string {
  return `ALTER TABLE ${table.name} ADD CONSTRAINT ${constraint.name} ${constraint.definition}`
}

export function renderPostgresCreateIndex(index: PostgresSchemaIndex): string {
  return `CREATE INDEX ${index.name} ${index.definition}`
}

export function renderPostgresSchemaSql(): string {
  const statements = [
    ...POSTGRES_NEWSLETTER_SCHEMA.tables.map(renderPostgresCreateTable),
    ...POSTGRES_NEWSLETTER_SCHEMA.indexes.map(renderPostgresCreateIndex)
  ]
  return `${statements.join(';\n\n')};\n`
}
