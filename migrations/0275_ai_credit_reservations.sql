CREATE TYPE ai_credit_reservation_status AS ENUM ('RESERVED', 'SETTLED', 'RELEASED');

CREATE TABLE IF NOT EXISTS ai_credit_reservations (
  id serial PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id text REFERENCES users(id) ON DELETE SET NULL,
  feature varchar(100) NOT NULL,
  credits integer NOT NULL,
  status ai_credit_reservation_status NOT NULL DEFAULT 'RESERVED',
  idempotency_key varchar(120),
  model varchar(100),
  metadata jsonb,
  created_at timestamp DEFAULT now() NOT NULL,
  updated_at timestamp DEFAULT now() NOT NULL,
  expires_at timestamp NOT NULL
);

CREATE INDEX IF NOT EXISTS ai_credit_res_org_created_idx ON ai_credit_reservations (org_id, created_at);
CREATE INDEX IF NOT EXISTS ai_credit_res_status_expires_idx ON ai_credit_reservations (status, expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_credit_res_org_idem_key ON ai_credit_reservations (org_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_credit_txns_purchase_ref ON ai_credit_transactions (org_id, reference_id) WHERE type = 'PURCHASE' AND reference_id IS NOT NULL;
