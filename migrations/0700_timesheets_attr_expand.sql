SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE timesheets ADD COLUMN IF NOT EXISTS locked_by_membership_id INTEGER;
--> statement-breakpoint
ALTER TABLE timesheet_audit_events ADD COLUMN IF NOT EXISTS actor_membership_id INTEGER;
--> statement-breakpoint
ALTER TABLE timesheet_exports ADD COLUMN IF NOT EXISTS created_by_membership_id INTEGER;
--> statement-breakpoint
ALTER TABLE timesheet_exports ADD COLUMN IF NOT EXISTS ack_by_membership_id INTEGER;
--> statement-breakpoint
ALTER TABLE timesheet_settings_history ADD COLUMN IF NOT EXISTS changed_by_membership_id INTEGER;
--> statement-breakpoint
ALTER TABLE timesheet_exceptions ADD COLUMN IF NOT EXISTS resolved_by_membership_id INTEGER;
--> statement-breakpoint
UPDATE timesheets t
SET locked_by_membership_id = om.id
FROM organization_members om
WHERE om.org_id = t.org_id
  AND om.user_id = t.locked_by
  AND t.locked_by IS NOT NULL
  AND t.locked_by_membership_id IS NULL;
--> statement-breakpoint
UPDATE timesheet_audit_events t
SET actor_membership_id = om.id
FROM organization_members om
WHERE om.org_id = t.org_id
  AND om.user_id = t.actor_user_id
  AND t.actor_user_id IS NOT NULL
  AND t.actor_membership_id IS NULL;
--> statement-breakpoint
UPDATE timesheet_exports t
SET created_by_membership_id = om.id
FROM organization_members om
WHERE om.org_id = t.org_id
  AND om.user_id = t.created_by
  AND t.created_by IS NOT NULL
  AND t.created_by_membership_id IS NULL;
--> statement-breakpoint
UPDATE timesheet_exports t
SET ack_by_membership_id = om.id
FROM organization_members om
WHERE om.org_id = t.org_id
  AND om.user_id = t.ack_by
  AND t.ack_by IS NOT NULL
  AND t.ack_by_membership_id IS NULL;
--> statement-breakpoint
UPDATE timesheet_settings_history t
SET changed_by_membership_id = om.id
FROM organization_members om
WHERE om.org_id = t.org_id
  AND om.user_id = t.changed_by
  AND t.changed_by IS NOT NULL
  AND t.changed_by_membership_id IS NULL;
--> statement-breakpoint
UPDATE timesheet_exceptions t
SET resolved_by_membership_id = om.id
FROM organization_members om
WHERE om.org_id = t.org_id
  AND om.user_id = t.resolved_by
  AND t.resolved_by IS NOT NULL
  AND t.resolved_by_membership_id IS NULL;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_timesheets_locked_by_membership') THEN
    ALTER TABLE timesheets
      ADD CONSTRAINT fk_timesheets_locked_by_membership
      FOREIGN KEY (org_id, locked_by_membership_id)
      REFERENCES organization_members (org_id, id)
      ON DELETE SET NULL NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_timesheet_audit_actor_membership') THEN
    ALTER TABLE timesheet_audit_events
      ADD CONSTRAINT fk_timesheet_audit_actor_membership
      FOREIGN KEY (org_id, actor_membership_id)
      REFERENCES organization_members (org_id, id)
      ON DELETE SET NULL NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_timesheet_exports_created_by_membership') THEN
    ALTER TABLE timesheet_exports
      ADD CONSTRAINT fk_timesheet_exports_created_by_membership
      FOREIGN KEY (org_id, created_by_membership_id)
      REFERENCES organization_members (org_id, id)
      ON DELETE SET NULL NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_timesheet_exports_ack_by_membership') THEN
    ALTER TABLE timesheet_exports
      ADD CONSTRAINT fk_timesheet_exports_ack_by_membership
      FOREIGN KEY (org_id, ack_by_membership_id)
      REFERENCES organization_members (org_id, id)
      ON DELETE SET NULL NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_ts_settings_history_changed_by_membership') THEN
    ALTER TABLE timesheet_settings_history
      ADD CONSTRAINT fk_ts_settings_history_changed_by_membership
      FOREIGN KEY (org_id, changed_by_membership_id)
      REFERENCES organization_members (org_id, id)
      ON DELETE SET NULL NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_timesheet_exceptions_resolved_by_membership') THEN
    ALTER TABLE timesheet_exceptions
      ADD CONSTRAINT fk_timesheet_exceptions_resolved_by_membership
      FOREIGN KEY (org_id, resolved_by_membership_id)
      REFERENCES organization_members (org_id, id)
      ON DELETE SET NULL NOT VALID;
  END IF;
END $$;
