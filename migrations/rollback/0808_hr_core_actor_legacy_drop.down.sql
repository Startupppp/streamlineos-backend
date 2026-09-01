-- Rollback for 0808_hr_core_actor_legacy_drop
--
-- IRRECOVERABLE DATA LOSS WARNING:
-- Migration 0808 dropped the legacy text columns created_by, approved_by
-- (hr_effective_dated_changes, hr_employment_history) and actor_id
-- (hr_audit_logs). Those values were backfilled into companion membership-id
-- columns before the drop, but the original text data (user UUIDs stored as
-- text) is not stored anywhere else. Rolling back the schema recreates the
-- columns as nullable text, but the original values are permanently gone
-- without a point-in-time restore. Do not apply this rollback expecting the
-- original data to be present.
--
-- This rollback recreates the columns and the dropped index so the schema
-- matches the pre-0808 shape. FK constraints that were implicitly dropped
-- with the column are NOT recreated here — they referenced users.id (text)
-- and would need a separate VALIDATE pass.

SET lock_timeout = '5s';

-- hr_effective_dated_changes: restore created_by and approved_by
ALTER TABLE hr_effective_dated_changes
  ADD COLUMN IF NOT EXISTS created_by text;

ALTER TABLE hr_effective_dated_changes
  ADD COLUMN IF NOT EXISTS approved_by text;

-- hr_employment_history: restore created_by
ALTER TABLE hr_employment_history
  ADD COLUMN IF NOT EXISTS created_by text;

-- hr_audit_logs: restore actor_id and its index
ALTER TABLE hr_audit_logs
  ADD COLUMN IF NOT EXISTS actor_id text;

CREATE INDEX IF NOT EXISTS idx_hr_audit_logs_actor
  ON hr_audit_logs (actor_id);
