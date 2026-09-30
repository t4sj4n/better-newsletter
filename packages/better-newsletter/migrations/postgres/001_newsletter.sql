CREATE TABLE newsletter_contacts (
  id text NOT NULL,
  capability_generation bigint NOT NULL DEFAULT 1,
  email text NOT NULL,
  status text NOT NULL,
  subject_namespace text,
  subject_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  suppressed_at timestamptz,
  suppression_reason text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT newsletter_contacts_pkey PRIMARY KEY (id),
  CONSTRAINT newsletter_contacts_capability_generation_check CHECK (capability_generation > 0),
  CONSTRAINT newsletter_contacts_email_key UNIQUE (email),
  CONSTRAINT newsletter_contacts_email_check CHECK (email = lower(btrim(email)) AND length(email) BETWEEN 1 AND 254),
  CONSTRAINT newsletter_contacts_status_check CHECK (status IN ('ENABLED', 'SUPPRESSED')),
  CONSTRAINT newsletter_contacts_metadata_check CHECK (jsonb_typeof(metadata) = 'object'),
  CONSTRAINT newsletter_contacts_subject_pair CHECK (
    (subject_namespace IS NULL AND subject_id IS NULL)
    OR (subject_namespace IS NOT NULL AND subject_id IS NOT NULL)
  )
);

CREATE TABLE newsletter_subscriptions (
  id text NOT NULL,
  contact_id text NOT NULL,
  audience_key text NOT NULL,
  lifecycle_generation bigint NOT NULL DEFAULT 1,
  status text NOT NULL,
  consent_version text NOT NULL,
  consent_source text,
  consent_locale text,
  consented_at timestamptz NOT NULL,
  confirmation_delivery_id text,
  confirmation_attempt_id text,
  confirmation_lease_expires_at timestamptz,
  confirmation_sent_at timestamptz,
  confirmed_at timestamptz,
  unsubscribed_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT newsletter_subscriptions_pkey PRIMARY KEY (id),
  CONSTRAINT newsletter_subscriptions_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES newsletter_contacts (id) ON DELETE CASCADE,
  CONSTRAINT newsletter_subscriptions_audience_key_check CHECK (audience_key = btrim(audience_key) AND length(audience_key) BETWEEN 1 AND 128),
  CONSTRAINT newsletter_subscriptions_lifecycle_generation_check CHECK (lifecycle_generation > 0),
  CONSTRAINT newsletter_subscriptions_status_check CHECK (status IN ('PENDING_CONFIRMATION', 'ACTIVE', 'UNSUBSCRIBED')),
  CONSTRAINT newsletter_subscriptions_contact_audience_key UNIQUE (contact_id, audience_key),
  CONSTRAINT newsletter_subscriptions_delivery_claim CHECK (
    (confirmation_delivery_id IS NULL
      AND confirmation_attempt_id IS NULL
      AND confirmation_lease_expires_at IS NULL)
    OR (confirmation_delivery_id IS NOT NULL
      AND (confirmation_attempt_id IS NULL) = (confirmation_lease_expires_at IS NULL))
  )
);

CREATE TABLE newsletter_tokens (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  digest text NOT NULL,
  purpose text NOT NULL,
  contact_id text NOT NULL,
  subscription_id text NOT NULL,
  lifecycle_generation bigint NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  revoked_at timestamptz,
  CONSTRAINT newsletter_tokens_pkey PRIMARY KEY (id),
  CONSTRAINT newsletter_tokens_digest_key UNIQUE (digest),
  CONSTRAINT newsletter_tokens_purpose_check CHECK (purpose = 'CONFIRMATION'),
  CONSTRAINT newsletter_tokens_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES newsletter_contacts (id) ON DELETE CASCADE,
  CONSTRAINT newsletter_tokens_subscription_id_fkey FOREIGN KEY (subscription_id) REFERENCES newsletter_subscriptions (id) ON DELETE CASCADE,
  CONSTRAINT newsletter_tokens_lifecycle_generation_check CHECK (lifecycle_generation > 0),
  CONSTRAINT newsletter_tokens_expiry CHECK (expires_at > created_at)
);

CREATE TABLE newsletter_events (
  id text NOT NULL,
  sequence bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  contact_id text NOT NULL,
  subscription_id text,
  event_type text NOT NULL,
  occurred_at timestamptz NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT newsletter_events_pkey PRIMARY KEY (id),
  CONSTRAINT newsletter_events_sequence_key UNIQUE (sequence),
  CONSTRAINT newsletter_events_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES newsletter_contacts (id) ON DELETE CASCADE,
  CONSTRAINT newsletter_events_subscription_id_fkey FOREIGN KEY (subscription_id) REFERENCES newsletter_subscriptions (id) ON DELETE CASCADE,
  CONSTRAINT newsletter_events_event_type_check CHECK (event_type <> ''),
  CONSTRAINT newsletter_events_metadata_check CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE TABLE newsletter_provider_events (
  provider text NOT NULL,
  event_id text NOT NULL,
  contact_id text NOT NULL,
  CONSTRAINT newsletter_provider_events_pkey PRIMARY KEY (provider, event_id),
  CONSTRAINT newsletter_provider_events_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES newsletter_contacts (id) ON DELETE CASCADE
);

CREATE TABLE newsletter_suppression_keys (
  key_hash text NOT NULL,
  CONSTRAINT newsletter_suppression_keys_pkey PRIMARY KEY (key_hash),
  CONSTRAINT newsletter_suppression_keys_key_hash_check CHECK (key_hash <> '')
);

CREATE TABLE newsletter_rate_limits (
  key_hash text NOT NULL,
  action text NOT NULL,
  window_ms bigint NOT NULL,
  bucket_start_ms bigint NOT NULL,
  expires_at timestamptz NOT NULL,
  attempt_count integer NOT NULL,
  CONSTRAINT newsletter_rate_limits_pkey PRIMARY KEY (key_hash, action, window_ms, bucket_start_ms),
  CONSTRAINT newsletter_rate_limits_key_hash_check CHECK (key_hash <> ''),
  CONSTRAINT newsletter_rate_limits_action_check CHECK (action <> ''),
  CONSTRAINT newsletter_rate_limits_window_ms_check CHECK (window_ms > 0),
  CONSTRAINT newsletter_rate_limits_bucket_start_ms_check CHECK (bucket_start_ms >= 0),
  CONSTRAINT newsletter_rate_limits_attempt_count_check CHECK (attempt_count > 0)
);

CREATE INDEX newsletter_provider_events_contact_id_idx ON newsletter_provider_events (contact_id);

CREATE INDEX newsletter_subscriptions_eligible_idx ON newsletter_subscriptions (audience_key, contact_id) WHERE status = 'ACTIVE' AND confirmed_at IS NOT NULL AND unsubscribed_at IS NULL;

CREATE INDEX newsletter_tokens_subscription_generation_retention_idx ON newsletter_tokens (subscription_id, lifecycle_generation, created_at DESC, id DESC);

CREATE INDEX newsletter_tokens_contact_id_idx ON newsletter_tokens (contact_id);

CREATE INDEX newsletter_tokens_expires_at_idx ON newsletter_tokens (expires_at);

CREATE INDEX newsletter_tokens_cleanup_idx ON newsletter_tokens (COALESCE(consumed_at, revoked_at, expires_at));

CREATE INDEX newsletter_events_contact_sequence_idx ON newsletter_events (contact_id, sequence);

CREATE INDEX newsletter_events_subscription_sequence_idx ON newsletter_events (subscription_id, sequence) WHERE subscription_id IS NOT NULL;

CREATE INDEX newsletter_events_soft_bounce_occurred_at_idx ON newsletter_events (contact_id, (metadata ->> 'feedbackOccurredAt') DESC) WHERE event_type = 'PROVIDER_FEEDBACK' AND metadata ->> 'feedbackType' = 'SOFT_BOUNCE';

CREATE INDEX newsletter_events_unsuppressed_idx ON newsletter_events (contact_id, sequence DESC) WHERE event_type = 'UNSUPPRESSED';

CREATE INDEX newsletter_rate_limits_expires_at_idx ON newsletter_rate_limits (expires_at);
