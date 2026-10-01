SET lock_timeout = '5s';
--> statement-breakpoint

-- BUG-TS-BE-006: uniq_timesheets_work_log held the one-entry-per-person-per-day
-- rule but did not exclude voided rows, so a voided entry kept holding its day
-- and the next entry for that date failed with 23505. Narrow the predicate to
-- live rows.
--
-- ON CONFLICT inference still matches: the only upsert against this index
-- (hr/time/work-logs.service.ts) infers with
-- `ticket_id IS NULL AND project_id IS NULL AND voided_at IS NULL`, which
-- implies the predicate below.
DROP INDEX IF EXISTS "uniq_timesheets_work_log";
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_timesheets_work_log"
  ON "timesheets" ("org_id", "user_membership_id", "date")
  WHERE ticket_id IS NULL AND voided_at IS NULL;
