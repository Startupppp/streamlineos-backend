-- Phase 2 / Workstream B / P0 #7 — rollback of b-qa-bug-01-expand.sql.
--
-- Safe only while the backfill has not run: it drops the sidecar and the
-- identity-map ledger. If b-qa-bug-02-backfill.sql has already committed, run
-- b-qa-bug-02-backfill-rollback.sql first, otherwise this file destroys the
-- only record of which work item replaced which bug.
--
-- The unique index on build.tickets is left in place on purpose. It is
-- additive, costs one index, and is the structural guarantee that stops a QA
-- sidecar row from drifting to a different project than its work item.

SET lock_timeout = '5s';
--> statement-breakpoint

ALTER TABLE "build"."test_run_results"
  DROP CONSTRAINT IF EXISTS "fk_test_run_results_org_work_item";
--> statement-breakpoint
DROP INDEX IF EXISTS "build"."idx_test_run_results_org_work_item";
--> statement-breakpoint
ALTER TABLE "build"."test_run_results"
  DROP COLUMN IF EXISTS "linked_work_item_id";
--> statement-breakpoint

DROP TABLE IF EXISTS "build"."bug_work_item_map";
--> statement-breakpoint
DROP TABLE IF EXISTS "build"."work_item_qa_details";
