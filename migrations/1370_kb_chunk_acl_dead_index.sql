SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF to_regclass('public.kb_article_chunks') IS NULL THEN
    RAISE EXCEPTION '1370 precondition: kb_article_chunks table is absent';
  END IF;
END $$;
--> statement-breakpoint

DROP INDEX IF EXISTS "idx_kb_chunks_org_page_acl";
--> statement-breakpoint

DO $$
BEGIN
  ASSERT NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'kb_article_chunks'
      AND indexname = 'idx_kb_chunks_org_page_acl'
  ), '1370 post-check: idx_kb_chunks_org_page_acl was not dropped';
END $$;
