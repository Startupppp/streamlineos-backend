SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF to_regclass('build.project_approvals') IS NULL THEN
    RAISE EXCEPTION '1500 precondition: build.project_approvals is absent';
  END IF;
END $$;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_project_approvals_approver_created_id"
  ON "build"."project_approvals" ("org_id", "approver_membership_id", "created_at" DESC, "id" DESC, "status")
  WHERE "deleted_at" IS NULL;
--> statement-breakpoint

DO $$
DECLARE
  definition text;
BEGIN
  SELECT pg_get_indexdef(x.indexrelid) INTO definition
    FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid
   WHERE i.relname = 'idx_project_approvals_approver_created_id'
     AND x.indrelid = 'build.project_approvals'::regclass;

  IF definition IS NULL THEN
    RAISE EXCEPTION '1500: idx_project_approvals_approver_created_id was not created';
  END IF;
  IF definition NOT LIKE '%(org_id, approver_membership_id, created_at DESC, id DESC, status)%' THEN
    RAISE EXCEPTION '1500: column order does not match the inbox keyset (org_id, approver_membership_id, created_at DESC, id DESC, status): %', definition;
  END IF;
  IF definition NOT LIKE '%deleted_at IS NULL%' THEN
    RAISE EXCEPTION '1500: the partial predicate does not match the inbox read (%)', definition;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relname = 'idx_project_approvals_approver_status' AND n.nspname = 'build'
  ) THEN
    RAISE EXCEPTION '1500: the narrow approver/status index is gone; it is not made redundant by this wider one';
  END IF;
END
$$;
--> statement-breakpoint
