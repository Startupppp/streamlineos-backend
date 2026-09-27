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
