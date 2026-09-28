CREATE TABLE newsletter_contacts (
  id text PRIMARY KEY,
  capability_generation bigint NOT NULL DEFAULT 1 CHECK (capability_generation > 0),
  email text NOT NULL UNIQUE
    CHECK (email = lower(btrim(email)) AND length(email) BETWEEN 1 AND 254),
  status text NOT NULL CHECK (status IN ('ENABLED', 'SUPPRESSED')),
  subject_namespace text,
  subject_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(metadata) = 'object'),
  suppressed_at timestamptz,
  suppression_reason text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT newsletter_contacts_subject_pair CHECK (
    (subject_namespace IS NULL AND subject_id IS NULL)
    OR (subject_namespace IS NOT NULL AND subject_id IS NOT NULL)
  )
);

CREATE TABLE newsletter_subscriptions (
  id text PRIMARY KEY,
  contact_id text NOT NULL REFERENCES newsletter_contacts (id) ON DELETE CASCADE,
  audience_key text NOT NULL
    CHECK (audience_key = btrim(audience_key) AND length(audience_key) BETWEEN 1 AND 128),
  lifecycle_generation bigint NOT NULL DEFAULT 1 CHECK (lifecycle_generation > 0),
  status text NOT NULL CHECK (status IN ('PENDING_CONFIRMATION', 'ACTIVE', 'UNSUBSCRIBED')),
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
  CONSTRAINT newsletter_subscriptions_contact_audience_key UNIQUE (contact_id, audience_key),
  CONSTRAINT newsletter_subscriptions_delivery_claim CHECK (
    (confirmation_delivery_id IS NULL
      AND confirmation_attempt_id IS NULL
      AND confirmation_lease_expires_at IS NULL)
    OR (confirmation_delivery_id IS NOT NULL
      AND (confirmation_attempt_id IS NULL) = (confirmation_lease_expires_at IS NULL))
  )
);

CREATE INDEX newsletter_subscriptions_eligible_idx
  ON newsletter_subscriptions (audience_key, contact_id)
  WHERE status = 'ACTIVE' AND confirmed_at IS NOT NULL AND unsubscribed_at IS NULL;

CREATE TABLE newsletter_tokens (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  digest text NOT NULL UNIQUE,
  purpose text NOT NULL CHECK (purpose = 'CONFIRMATION'),
  contact_id text NOT NULL REFERENCES newsletter_contacts (id) ON DELETE CASCADE,
  subscription_id text NOT NULL REFERENCES newsletter_subscriptions (id) ON DELETE CASCADE,
  lifecycle_generation bigint NOT NULL CHECK (lifecycle_generation > 0),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  revoked_at timestamptz,
  CONSTRAINT newsletter_tokens_expiry CHECK (expires_at > created_at)
);

CREATE INDEX newsletter_tokens_subscription_generation_retention_idx
  ON newsletter_tokens (subscription_id, lifecycle_generation, created_at DESC, id DESC);
CREATE INDEX newsletter_tokens_contact_id_idx ON newsletter_tokens (contact_id);
CREATE INDEX newsletter_tokens_expires_at_idx ON newsletter_tokens (expires_at);
CREATE INDEX newsletter_tokens_cleanup_idx
  ON newsletter_tokens (COALESCE(consumed_at, revoked_at, expires_at));

CREATE TABLE newsletter_events (
  id text PRIMARY KEY,
  sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  contact_id text NOT NULL REFERENCES newsletter_contacts (id) ON DELETE CASCADE,
  subscription_id text REFERENCES newsletter_subscriptions (id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (event_type <> ''),
  occurred_at timestamptz NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX newsletter_events_contact_sequence_idx
  ON newsletter_events (contact_id, sequence);
CREATE INDEX newsletter_events_subscription_sequence_idx
  ON newsletter_events (subscription_id, sequence) WHERE subscription_id IS NOT NULL;

CREATE TABLE newsletter_rate_limits (
  key_hash text NOT NULL CHECK (key_hash <> ''),
  action text NOT NULL CHECK (action <> ''),
  window_ms bigint NOT NULL CHECK (window_ms > 0),
  bucket_start_ms bigint NOT NULL CHECK (bucket_start_ms >= 0),
  expires_at timestamptz NOT NULL,
  attempt_count integer NOT NULL CHECK (attempt_count > 0),
  PRIMARY KEY (key_hash, action, window_ms, bucket_start_ms)
);

CREATE INDEX newsletter_rate_limits_expires_at_idx ON newsletter_rate_limits (expires_at);
