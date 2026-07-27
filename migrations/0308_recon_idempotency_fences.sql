-- ============================================================================
-- Hardening — persisted idempotency fence for sensitive commands (command_fences)
-- ============================================================================
-- Additive + idempotent. Apply on a Neon BRANCH first. Matches src/db/schema/idempotency.ts.
-- Fence key is (organization_id, audience, idempotency_key). A completed record replays its
-- stored response; an in-flight duplicate is rejected 409; a reused key with a different
-- request hash is rejected 422. A periodic sweep should DELETE WHERE expires_at < now().
-- ============================================================================

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'command_fence_status') THEN
    CREATE TYPE command_fence_status AS ENUM ('IN_FLIGHT', 'COMPLETED', 'FAILED');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS command_fences (
  command_fence_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  audience text NOT NULL DEFAULT 'internal',
  idempotency_key text NOT NULL,
  command_name text NOT NULL,
  request_hash text NOT NULL,
  principal_id text NOT NULL,
  status command_fence_status NOT NULL DEFAULT 'IN_FLIGHT',
  response_body jsonb,
  response_status integer,
  lease_expires_at timestamp NOT NULL,
  expires_at timestamp NOT NULL,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_command_fences_org_audience_key
  ON command_fences (organization_id, audience, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_command_fences_expires
  ON command_fences (expires_at);
