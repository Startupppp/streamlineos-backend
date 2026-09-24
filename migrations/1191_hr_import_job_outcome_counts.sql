-- 1191 — HR imports: record what a commit actually did, not just that it ran.
--
-- `hr_import_jobs.valid_rows` carried two different meanings on either side of a
-- commit: the preview's "rows that parsed" and, after commitJob overwrote it, the
-- count of rows the loop got through. Neither says whether anything was written.
-- That is how HRMS-E2E-003, -004 and -005 could each report "Committed, Valid N,
-- Errors 0" over a table that gained no rows — the number was true and answered a
-- question nobody was asking.
--
-- Now that a row can create, update or leave a record alone — which is what makes
-- re-importing a corrected sheet idempotent rather than duplicating the estate —
-- the three outcomes are counted separately and the job carries them. The reads
-- that matter become possible: "the file changed nothing" is visible as
-- unchanged = N, and "the commit wrote nothing at all" is created = updated = 0.
--
-- Additive and backfilled to 0. Jobs committed before this migration have no
-- per-outcome record and report zeroes; `valid_rows` still holds their total, so
-- no history is lost or misstated.
--
-- Rollback: migrations/rollback/1191_hr_import_job_outcome_counts.down.sql

SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE hr_import_jobs
  ADD COLUMN IF NOT EXISTS created_rows integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE hr_import_jobs
  ADD COLUMN IF NOT EXISTS updated_rows integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE hr_import_jobs
  ADD COLUMN IF NOT EXISTS unchanged_rows integer NOT NULL DEFAULT 0;
