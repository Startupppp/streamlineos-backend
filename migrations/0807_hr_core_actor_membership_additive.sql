SET lock_timeout = '5s';
--> statement-breakpoint
-- ────────────────────────────────────────────────────────────────
-- hr_effective_dated_changes: add created_by_membership_id
-- ────────────────────────────────────────────────────────────────
ALTER TABLE hr_effective_dated_changes
  ADD COLUMN IF NOT EXISTS created_by_membership_id integer;
--> statement-breakpoint
UPDATE hr_effective_dated_changes t
  SET created_by_membership_id = m.id
  FROM organization_members m
  WHERE m.org_id = t.org_id
    AND m.user_id = t.created_by
    AND t.created_by_membership_id IS NULL;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_hr_eff_changes_created_actor' AND contype = 'f'
  ) THEN
    ALTER TABLE hr_effective_dated_changes
      ADD CONSTRAINT fk_hr_eff_changes_created_actor
      FOREIGN KEY (org_id, created_by_membership_id)
      REFERENCES organization_members (org_id, id)
      ON DELETE SET NULL (created_by_membership_id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE hr_effective_dated_changes
  VALIDATE CONSTRAINT fk_hr_eff_changes_created_actor;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_hr_eff_changes_created_actor
  ON hr_effective_dated_changes (org_id, created_by_membership_id);
--> statement-breakpoint
-- ────────────────────────────────────────────────────────────────
-- hr_effective_dated_changes: add approved_by_membership_id
-- ────────────────────────────────────────────────────────────────
ALTER TABLE hr_effective_dated_changes
  ADD COLUMN IF NOT EXISTS approved_by_membership_id integer;
--> statement-breakpoint
UPDATE hr_effective_dated_changes t
  SET approved_by_membership_id = m.id
  FROM organization_members m
  WHERE m.org_id = t.org_id
    AND m.user_id = t.approved_by
    AND t.approved_by_membership_id IS NULL;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_hr_eff_changes_approved_actor' AND contype = 'f'
  ) THEN
    ALTER TABLE hr_effective_dated_changes
      ADD CONSTRAINT fk_hr_eff_changes_approved_actor
      FOREIGN KEY (org_id, approved_by_membership_id)
      REFERENCES organization_members (org_id, id)
      ON DELETE SET NULL (approved_by_membership_id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE hr_effective_dated_changes
  VALIDATE CONSTRAINT fk_hr_eff_changes_approved_actor;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_hr_eff_changes_approved_actor
  ON hr_effective_dated_changes (org_id, approved_by_membership_id);
--> statement-breakpoint
-- ────────────────────────────────────────────────────────────────
-- hr_employment_history: add created_by_membership_id
-- ────────────────────────────────────────────────────────────────
ALTER TABLE hr_employment_history
  ADD COLUMN IF NOT EXISTS created_by_membership_id integer;
--> statement-breakpoint
UPDATE hr_employment_history t
  SET created_by_membership_id = m.id
  FROM organization_members m
  WHERE m.org_id = t.org_id
    AND m.user_id = t.created_by
    AND t.created_by_membership_id IS NULL;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_hr_emp_history_created_actor' AND contype = 'f'
  ) THEN
    ALTER TABLE hr_employment_history
      ADD CONSTRAINT fk_hr_emp_history_created_actor
      FOREIGN KEY (org_id, created_by_membership_id)
      REFERENCES organization_members (org_id, id)
      ON DELETE SET NULL (created_by_membership_id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE hr_employment_history
  VALIDATE CONSTRAINT fk_hr_emp_history_created_actor;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_hr_emp_history_created_actor
  ON hr_employment_history (org_id, created_by_membership_id);
--> statement-breakpoint
-- ────────────────────────────────────────────────────────────────
-- hr_audit_logs: backfill actor_membership_id (column added in 0609, no FK yet)
-- ────────────────────────────────────────────────────────────────
UPDATE hr_audit_logs t
  SET actor_membership_id = m.id
  FROM organization_members m
  WHERE m.org_id = t.org_id
    AND m.user_id = t.actor_id
    AND t.actor_membership_id IS NULL;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_hr_audit_logs_actor_membership' AND contype = 'f'
  ) THEN
    ALTER TABLE hr_audit_logs
      ADD CONSTRAINT fk_hr_audit_logs_actor_membership
      FOREIGN KEY (org_id, actor_membership_id)
      REFERENCES organization_members (org_id, id)
      ON DELETE SET NULL (actor_membership_id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE hr_audit_logs
  VALIDATE CONSTRAINT fk_hr_audit_logs_actor_membership;
