-- Rollback for 0812_payroll_actor_legacy_drop
--
-- IRRECOVERABLE DATA LOSS WARNING:
-- Migration 0812 dropped approved_by from payroll_runs and acted_by from
-- payroll_approvals (legacy users.id FK columns) after the companion
-- membership-id columns were fully backfilled. The original values are
-- permanently gone without a point-in-time restore. This rollback recreates
-- the columns as nullable text so the schema matches the pre-0812 shape.

SET lock_timeout = '5s';

-- payroll_runs: restore approved_by as nullable text
ALTER TABLE payroll_runs
  ADD COLUMN IF NOT EXISTS approved_by text;

-- payroll_approvals: restore acted_by as nullable text
ALTER TABLE payroll_approvals
  ADD COLUMN IF NOT EXISTS acted_by text;
