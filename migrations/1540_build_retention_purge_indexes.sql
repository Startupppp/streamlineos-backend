SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF to_regclass('build.tickets') IS NULL THEN
    RAISE EXCEPTION '1540 precondition: build.tickets is absent';
  END IF;
  IF to_regclass('build.project_attachments') IS NULL THEN
    RAISE EXCEPTION '1540 precondition: build.project_attachments is absent';
  END IF;
END $$;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_tickets_org_project_deleted_at"
  ON "build"."tickets" ("org_id", "project_id", "deleted_at")
  WHERE "deleted_at" IS NOT NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_project_attachments_org_project_deleted_at"
  ON "build"."project_attachments" ("org_id", "project_id", "deleted_at")
  WHERE "deleted_at" IS NOT NULL;
--> statement-breakpoint

DO $$
DECLARE
  definition text;
BEGIN
  SELECT pg_get_indexdef(x.indexrelid) INTO definition
    FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid
   WHERE i.relname = 'idx_tickets_org_project_deleted_at'
     AND x.indrelid = 'build.tickets'::regclass;
  IF definition IS NULL THEN
    RAISE EXCEPTION '1540: idx_tickets_org_project_deleted_at was not created';
  END IF;
  IF definition NOT LIKE '%(org_id, project_id, deleted_at)%' THEN
    RAISE EXCEPTION '1540: ticket index column order does not match the retention purge selection (org_id, project_id, deleted_at): %', definition;
  END IF;
  IF definition NOT LIKE '%deleted_at IS NOT NULL%' THEN
    RAISE EXCEPTION '1540: the ticket index predicate must cover the soft-deleted rows the purge reads (%)', definition;
  END IF;

  SELECT pg_get_indexdef(x.indexrelid) INTO definition
    FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid
   WHERE i.relname = 'idx_project_attachments_org_project_deleted_at'
     AND x.indrelid = 'build.project_attachments'::regclass;
  IF definition IS NULL THEN
    RAISE EXCEPTION '1540: idx_project_attachments_org_project_deleted_at was not created';
  END IF;
  IF definition NOT LIKE '%(org_id, project_id, deleted_at)%' THEN
    RAISE EXCEPTION '1540: attachment index column order does not match the retention purge selection (org_id, project_id, deleted_at): %', definition;
  END IF;
  IF definition NOT LIKE '%deleted_at IS NOT NULL%' THEN
    RAISE EXCEPTION '1540: the attachment index predicate must cover the soft-deleted rows the purge reads (%)', definition;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relname = 'idx_project_attachments_org_project_cursor' AND n.nspname = 'build'
  ) THEN
    RAISE EXCEPTION '1540: the live-rows cursor index is gone; a deleted-rows index does not replace it';
  END IF;
END
$$;
--> statement-breakpoint
