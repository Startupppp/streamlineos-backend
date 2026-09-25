-- Restores the kb_pages.source_article_id bridge column and its partial unique index.
--
-- A structural restore is a COMPLETE restore for this database only because every row
-- was NULL when 1226 ran and public.kb_articles no longer exists to repopulate it. The
-- forward migration refuses to run while any row carries a value, so that precondition
-- is what makes this rollback lossless rather than an assumption made here.
SET lock_timeout = '5s';
--> statement-breakpoint

DO $rollback_1226$
BEGIN
  IF to_regclass('public.kb_pages') IS NULL THEN
    RAISE EXCEPTION '1226 rollback: public.kb_pages is absent';
  END IF;

  ALTER TABLE "public"."kb_pages"
    ADD COLUMN IF NOT EXISTS "source_article_id" integer;

  CREATE UNIQUE INDEX IF NOT EXISTS "uniq_kb_pages_org_source_article"
    ON "public"."kb_pages" ("org_id", "source_article_id")
    WHERE "source_article_id" IS NOT NULL;

  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'public.kb_pages'::regclass
      AND attname = 'source_article_id' AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION '1226 rollback postcondition failed: kb_pages.source_article_id was not restored';
  END IF;

  IF to_regclass('public.uniq_kb_pages_org_source_article') IS NULL THEN
    RAISE EXCEPTION '1226 rollback postcondition failed: uniq_kb_pages_org_source_article was not restored';
  END IF;
END $rollback_1226$;
--> statement-breakpoint
