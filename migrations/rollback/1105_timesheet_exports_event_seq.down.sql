-- Reverses 1105. The counter is derived state — the outbox rows it numbered
-- keep their versions — so dropping it loses nothing that cannot be re-derived
-- from the outbox; the application must go back to a version scheme of its own
-- before this runs, or the next acknowledgement fails on the missing column.
SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "timesheet_exports" DROP COLUMN IF EXISTS "event_seq";
