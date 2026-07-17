-- AI confirmation infrastructure: server-enforced confirmation tokens for consequential AI writes.
-- DO NOT APPLY automatically; run manually in a TTY session.

CREATE TYPE ai_proposal_status AS ENUM ('PROPOSED', 'CONFIRMED', 'EXECUTED', 'EXPIRED', 'CANCELLED');

CREATE TABLE IF NOT EXISTS ai_action_proposals (
  id serial PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action varchar(100) NOT NULL,
  payload jsonb NOT NULL,
  payload_hash varchar(64) NOT NULL,
  status ai_proposal_status NOT NULL DEFAULT 'PROPOSED',
  idempotency_key varchar(120),
  expires_at timestamp NOT NULL,
  executed_at timestamp,
  result jsonb,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_proposals_org_user_created
  ON ai_action_proposals (org_id, user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_proposals_status_expires
  ON ai_action_proposals (status, expires_at);

CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_proposals_org_idem_key
  ON ai_action_proposals (org_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;