-- Create dunning_attempts table.
--
-- Replaces the growing dunningAttempts[] array in subscriptions.metadata JSONB.
-- Each row is one dunning milestone attempt for one billing cycle of one subscription.
-- The unique constraint on (org_id, subscription_id, period_start, milestone) makes
-- the dunning cron idempotent: re-running it for the same cycle and milestone is a no-op.
--
-- PRECONDITION:
--   Migration 0380_subscription_status_suspended.sql must be committed first so that
--   the subscription_status enum is fully stable before this table references it
--   (indirectly, via the subscriptions FK).
--
-- REVERSIBILITY: Fully reversible — see .down.sql.

CREATE TABLE IF NOT EXISTS dunning_attempts (
  id                 bigint                   PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  org_id             text                     NOT NULL
                                                REFERENCES organizations (id) ON DELETE CASCADE,
  subscription_id    integer                  NOT NULL
                                                REFERENCES subscriptions (id) ON DELETE CASCADE,
  period_start       timestamp                NOT NULL,
  milestone          text                     NOT NULL,
  status             text                     NOT NULL DEFAULT 'PENDING',
  outcome            text,
  notification_ref   text,
  provider_retry_id  text,
  attempted_at       timestamp                NOT NULL DEFAULT now(),
  resolved_at        timestamp,
  created_at         timestamp                NOT NULL DEFAULT now(),
  updated_at         timestamp                NOT NULL DEFAULT now(),

  CONSTRAINT chk_dunning_milestone
    CHECK (milestone IN ('D+1','D+3','D+7','D+14')),
  CONSTRAINT chk_dunning_status
    CHECK (status IN ('PENDING','SENT','FAILED','SKIPPED')),
  CONSTRAINT chk_dunning_outcome
    CHECK (outcome IS NULL OR outcome IN ('PAYMENT_RECEIVED','NO_RESPONSE','BOUNCED','CANCELLED'))
);

-- Composite tenant PK (org_id, id) — the canonical cross-tenant uniqueness pattern.
ALTER TABLE dunning_attempts
  ADD CONSTRAINT uniq_dunning_attempts_org_id UNIQUE (org_id, id);

-- Idempotency constraint: same milestone cannot fire twice in the same billing cycle.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_dunning_attempt_cycle_milestone
  ON dunning_attempts (org_id, subscription_id, period_start, milestone);

-- General org-scoped lookup index.
CREATE INDEX IF NOT EXISTS idx_dunning_attempts_org_sub_period
  ON dunning_attempts (org_id, subscription_id, period_start);

-- Partial index: efficiently answers "which orgs have a pending attempt at milestone X?".
-- Supports the cron query: WHERE status = 'PENDING' AND milestone = 'D+7'
CREATE INDEX IF NOT EXISTS idx_dunning_attempts_pending_milestone
  ON dunning_attempts (milestone, org_id)
  WHERE status = 'PENDING';
