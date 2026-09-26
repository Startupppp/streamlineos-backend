SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF to_regclass('public.kb_pages') IS NULL THEN
    RAISE EXCEPTION '1350 precondition: kb_pages table is absent';
  END IF;
END $$;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_kb_pages_org_created_by_id"
  ON "kb_pages" ("org_id", "created_by_id")
  WHERE deleted_at IS NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_kb_pages_org_created_by_membership_id"
  ON "kb_pages" ("org_id", "created_by_membership_id")
  WHERE deleted_at IS NULL;
--> statement-breakpoint

DO $$
BEGIN
  ASSERT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'kb_pages'
      AND indexname = 'idx_kb_pages_org_created_by_id'
  ), '1350 post-check: idx_kb_pages_org_created_by_id was not created';
  ASSERT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'kb_pages'
      AND indexname = 'idx_kb_pages_org_created_by_membership_id'
  ), '1350 post-check: idx_kb_pages_org_created_by_membership_id was not created';
END $$;
