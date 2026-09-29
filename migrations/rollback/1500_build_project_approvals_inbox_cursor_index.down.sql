SET lock_timeout = '5s';
--> statement-breakpoint

DROP INDEX IF EXISTS "build"."idx_project_approvals_approver_created_id";
--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relname = 'idx_project_approvals_approver_created_id' AND n.nspname = 'build'
  ) THEN
    RAISE EXCEPTION '1500 rollback: idx_project_approvals_approver_created_id is still present';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relname = 'idx_project_approvals_approver_status' AND n.nspname = 'build'
  ) THEN
    RAISE EXCEPTION '1500 rollback: idx_project_approvals_approver_status is absent, the inbox would have no supporting index';
  END IF;
END
$$;
--> statement-breakpoint
