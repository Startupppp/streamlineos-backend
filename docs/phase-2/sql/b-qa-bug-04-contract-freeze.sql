-- Phase 2 / Workstream B / P0 #7 — QA bug consolidation, CONTRACT phase 1 of 2
-- (FREEZE). Reversible. Destroys no data.
--
-- Preconditions: b-qa-bug-03-verify.sql returned 0 for every expectation, and
-- the application has been deployed with the QA bug routes reading and writing
-- the canonical work item (see section 7 of the design note). Apply this only
-- after that deploy, never before: it removes the write grant on build.bugs,
-- so any surviving legacy writer starts raising 42501 instead of silently
-- forking the two identities again.
--
-- Reversal: re-grant INSERT, UPDATE, DELETE on build.bugs to streamline_app.
-- The rows are untouched, so the legacy routes resume working immediately.
-- The FK validation is not reversed; it only proves existing data is sound.
--
-- Not a drizzle migration. No migrations/meta/_journal.json entry.

SET lock_timeout = '5s';
--> statement-breakpoint

ALTER TABLE "build"."test_run_results"
  VALIDATE CONSTRAINT "fk_test_run_results_org_work_item";
--> statement-breakpoint

REVOKE INSERT, UPDATE, DELETE ON "build"."bugs" FROM streamline_app;
