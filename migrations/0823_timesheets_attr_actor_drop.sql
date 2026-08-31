-- 0823_timesheets_attr_actor_drop
-- Drop three ATTRIBUTION legacy users.id columns from timesheets now that
-- companions exist and code no longer reads them:
--
--   timesheet_audit_events   actor_user_id   (companion: actor_membership_id, from schema)
--   timesheet_exceptions     owner_user_id   (companion: owner_membership_id, from 0809)
--   timesheet_periods        current_approver_id  (companion: current_approver_membership_id, 0809)
--
-- Special note on audit hash chain:
--   computeAuditRowHash has been updated to use actorMembershipId instead of
--   actorUserId. Pre-migration rows whose row_hash was computed with actorUserId
--   are reset to NULL before the column drop so verifyChain skips them (treating
--   them like pre-hash-chain rows, already the established pattern for legacyRows).

SET lock_timeout = '5s';
--> statement-breakpoint

-- Pre-flight: companion FKs must be validated
DO $$
DECLARE
  unvalidated text;
BEGIN
  SELECT string_agg(conname, ', ') INTO unvalidated
  FROM pg_constraint
  WHERE conname IN (
    'fk_timesheet_audit_actor_membership',
    'fk_timesheet_exceptions_owner_membership',
    'fk_timesheet_periods_current_approver_membership'
  )
    AND contype = 'f'
    AND NOT convalidated;

  IF unvalidated IS NOT NULL THEN
    RAISE EXCEPTION '0823: companion FKs not yet validated: %', unvalidated;
  END IF;
END $$;
--> statement-breakpoint

-- Reset hash-chain for rows whose hash was computed with actor_user_id.
-- verifyChain already skips rows where row_hash IS NULL (legacyRows counter).
-- Only reset rows that have actor_user_id set but actor_membership_id mapped —
-- these are the pre-cutover rows that will mismatch the new algorithm.
-- Rows where actor_membership_id IS NULL (un-mappable departed members) are kept
-- as-is since their hash cannot be re-verified regardless.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'timesheet_audit_events' AND column_name = 'actor_user_id'
  ) THEN
    EXECUTE $q$
      UPDATE timesheet_audit_events
      SET row_hash = NULL, prev_hash = NULL
      WHERE actor_user_id IS NOT NULL
        AND actor_membership_id IS NOT NULL
        AND row_hash IS NOT NULL
    $q$;
  END IF;
END $$;
--> statement-breakpoint

-- Drop actor_user_id FK then column
ALTER TABLE timesheet_audit_events DROP CONSTRAINT IF EXISTS timesheet_audit_events_actor_user_id_fkey;
--> statement-breakpoint
ALTER TABLE timesheet_audit_events DROP COLUMN IF EXISTS actor_user_id;
--> statement-breakpoint

-- Drop owner_user_id FK then column
ALTER TABLE timesheet_exceptions DROP CONSTRAINT IF EXISTS timesheet_exceptions_owner_user_id_fkey;
--> statement-breakpoint
ALTER TABLE timesheet_exceptions DROP COLUMN IF EXISTS owner_user_id;
--> statement-breakpoint

-- Drop current_approver_id FK then column
ALTER TABLE timesheet_periods DROP CONSTRAINT IF EXISTS timesheet_periods_current_approver_id_fkey;
--> statement-breakpoint
ALTER TABLE timesheet_periods DROP COLUMN IF EXISTS current_approver_id;
--> statement-breakpoint

-- Post-flight
DO $$
DECLARE
  still_present text;
BEGIN
  SELECT string_agg(format('%s.%s', tbl, col), ', ') INTO still_present
  FROM (VALUES
    ('timesheet_audit_events', 'actor_user_id'),
    ('timesheet_exceptions', 'owner_user_id'),
    ('timesheet_periods', 'current_approver_id')
  ) AS t(tbl, col)
  WHERE EXISTS (
    SELECT 1 FROM information_schema.columns c
    WHERE c.table_name = t.tbl AND c.column_name = t.col
  );

  IF still_present IS NOT NULL THEN
    RAISE EXCEPTION '0823: legacy columns still present: %', still_present;
  END IF;
END $$;
