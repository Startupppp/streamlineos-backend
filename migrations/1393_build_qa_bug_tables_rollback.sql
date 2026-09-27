-- 1393-rollback — Drop work_item_qa_details and bug_work_item_map tables
--
-- WARNING: this rollback drops both tables (and all their data).
-- Only run after confirming that the bug service and QA module are no longer
-- in production, or after a full data evacuation.
--
-- The linked_work_item_id column on test_run_results is NOT rolled back here
-- because it may have been added independently and dropping it risks data loss
-- on a table the test-run service writes to in production.

SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF to_regclass('build.work_item_qa_details') IS NULL
    AND to_regclass('build.bug_work_item_map') IS NULL THEN
    RAISE EXCEPTION '1393-rollback precondition: neither table exists — cannot roll back';
  END IF;
END $$;
--> statement-breakpoint

DROP TABLE IF EXISTS build.bug_work_item_map;
--> statement-breakpoint

DROP TABLE IF EXISTS build.work_item_qa_details;
--> statement-breakpoint

DROP INDEX IF EXISTS build.uniq_tickets_org_project_id;
--> statement-breakpoint

DO $$
BEGIN
  ASSERT to_regclass('build.work_item_qa_details') IS NULL,
    '1393-rollback post-check: build.work_item_qa_details still exists';
  ASSERT to_regclass('build.bug_work_item_map') IS NULL,
    '1393-rollback post-check: build.bug_work_item_map still exists';
END $$;
