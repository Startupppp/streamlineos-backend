-- Rollback for 1707 (BE-71). Returns `timesheets` to 0824's single over-broad
-- index, which is what the database held before 1707 ran.
--
-- This is a rollback, not a repair: reinstating 0824's index reinstates BOTH
-- defects 1707 fixes — a voided row holds its day again, and two live ticketless
-- entries on different projects collide again. It also fails outright if the
-- table already holds rows 0824's index cannot accept, which is the correct
-- outcome: the data moved on, and the way back is forward.
SET lock_timeout = '5s';
--> statement-breakpoint

DROP INDEX IF EXISTS "uniq_timesheets_day_project";
--> statement-breakpoint

DROP INDEX IF EXISTS "uniq_timesheets_work_log";
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_timesheets_work_log"
  ON "timesheets" ("org_id", "user_membership_id", "date")
  WHERE ticket_id IS NULL;
