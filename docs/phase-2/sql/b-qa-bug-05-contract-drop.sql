-- Phase 2 / Workstream B / P0 #7 — QA bug consolidation, CONTRACT phase 2 of 2
-- (DROP). Destructive. Apply only after the rollback window on
-- b-qa-bug-04-contract-freeze.sql has closed.
--
-- Preconditions:
--   1. b-qa-bug-04-contract-freeze.sql has been in production for the agreed
--      rollback window with no 42501 on build.bugs in the error log.
--   2. A logical dump of build.bugs and build.test_run_results.linked_bug_id
--      is stored with the change record. build.bug_work_item_map is the only
--      in-database record of the legacy identity that survives this file, and
--      it deliberately has no foreign key to build.bugs so it outlives the drop.
--   3. No source file references `bugs` in src/db/schema, src/modules/build/qa,
--      or the frontend bug feature (see section 9 of the design note).
--
-- Reversal: restore build.bugs from the dump in precondition 2, re-add
-- test_run_results.linked_bug_id and repopulate it from build.bug_work_item_map
-- joined to the restored rows. There is no in-place undo.
--
-- Not a drizzle migration. No migrations/meta/_journal.json entry.

SET lock_timeout = '5s';
--> statement-breakpoint

ALTER TABLE "build"."test_run_results"
  DROP CONSTRAINT IF EXISTS "fk_test_run_results_org_bug";
--> statement-breakpoint
ALTER TABLE "build"."test_run_results"
  DROP COLUMN IF EXISTS "linked_bug_id";
--> statement-breakpoint

DROP TABLE IF EXISTS "build"."bugs";
--> statement-breakpoint

DROP TYPE IF EXISTS "public"."bug_priority";
