SET lock_timeout = '5s';
--> statement-breakpoint

-- BUG-TS-BE-012: approve-with-lock stamped locked_at and emitted
-- timesheets.period.locked but left the status at APPROVED, so the row and its
-- own event stream disagreed and the LOCKED state was reachable only through
-- the explicit lock route. Those periods are locked; the status now says so.
-- No lifecycle event is emitted here: the locked event was already published
-- when the period was approved, so event_seq must not move.
UPDATE "timesheet_periods"
SET "status" = 'LOCKED'
WHERE "status" = 'APPROVED'
  AND "locked_at" IS NOT NULL;
