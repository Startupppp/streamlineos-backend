SET lock_timeout = '5s';
--> statement-breakpoint
-- Guard: all companion membership columns must be fully populated before we drop the legacy text columns.
-- Any row with a non-null legacy column and a null membership column means the backfill or dual-write missed it.
DO $$
DECLARE bad integer;
BEGIN
  SELECT COUNT(*) INTO bad
  FROM hr_effective_dated_changes
  WHERE created_by IS NOT NULL AND created_by_membership_id IS NULL;
  IF bad > 0 THEN
    RAISE EXCEPTION '0808 blocked: % hr_effective_dated_changes rows have created_by set but created_by_membership_id is NULL', bad;
  END IF;

  SELECT COUNT(*) INTO bad
  FROM hr_effective_dated_changes
  WHERE approved_by IS NOT NULL AND approved_by_membership_id IS NULL;
  IF bad > 0 THEN
    RAISE EXCEPTION '0808 blocked: % hr_effective_dated_changes rows have approved_by set but approved_by_membership_id is NULL', bad;
  END IF;

  SELECT COUNT(*) INTO bad
  FROM hr_employment_history
  WHERE created_by IS NOT NULL AND created_by_membership_id IS NULL;
  IF bad > 0 THEN
    RAISE EXCEPTION '0808 blocked: % hr_employment_history rows have created_by set but created_by_membership_id is NULL', bad;
  END IF;

  SELECT COUNT(*) INTO bad
  FROM hr_audit_logs
  WHERE actor_id IS NOT NULL AND actor_membership_id IS NULL;
  IF bad > 0 THEN
    RAISE EXCEPTION '0808 blocked: % hr_audit_logs rows have actor_id set but actor_membership_id is NULL — re-run backfill in 0807', bad;
  END IF;
END $$;
--> statement-breakpoint
-- Drop the legacy FK constraint on hr_effective_dated_changes.created_by before dropping the column
ALTER TABLE hr_effective_dated_changes
  DROP COLUMN IF EXISTS created_by;
--> statement-breakpoint
ALTER TABLE hr_effective_dated_changes
  DROP COLUMN IF EXISTS approved_by;
--> statement-breakpoint
ALTER TABLE hr_employment_history
  DROP COLUMN IF EXISTS created_by;
--> statement-breakpoint
-- Drop the legacy actor_id index before dropping the column
DROP INDEX IF EXISTS idx_hr_audit_logs_actor;
--> statement-breakpoint
ALTER TABLE hr_audit_logs
  DROP COLUMN IF EXISTS actor_id;
