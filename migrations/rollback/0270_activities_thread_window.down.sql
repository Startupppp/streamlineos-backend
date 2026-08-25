-- Rollback for 0270: put `idx_activities_thread` back and drop the window index.
--
-- Restores the exact shape `0215` declared — ("organization_id", "thread_id"),
-- no predicate — so a revert leaves the thread lookup served the way it was
-- before the window existed. Index-only, so nothing here touches a row.

SET statement_timeout = 0;
--> statement-breakpoint
SET lock_timeout = '5s';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_activities_thread"
  ON "activities" USING btree ("organization_id", "thread_id");
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_activities_thread_window";
