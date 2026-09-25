-- @data-loss
-- Removes the last article->page bridge column. 1174 dropped public.kb_articles, so
-- nothing can write kb_pages.source_article_id ever again; it is a permanently-NULL
-- column still published through the wiki response contract.
--
-- This migration refuses to run while the bridge still carries a value, so it cannot
-- silently discard a half-finished cutover. Measured against production before writing:
-- kb_pages holds 22 rows, 0 of them with a non-null source_article_id.
--
-- Deliberately NOT touched, because they are live columns under a legacy name rather
-- than bridge residue:
--   kb_events.article_id                     - holds kb_pages ids (support-kb-gap reads it)
--   support_knowledge_gaps.proposed_article_id - holds kb_pages ids (joined to kb_pages.id)
-- Renaming those is a separate, non-destructive change with its own callers to move.
SET lock_timeout = '5s';
--> statement-breakpoint

DO $migration_1226$
DECLARE
  bridged integer;
BEGIN
  IF to_regclass('public.kb_pages') IS NULL THEN
    RAISE EXCEPTION '1226 precondition: public.kb_pages is absent';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'public.kb_pages'::regclass
      AND attname = 'source_article_id' AND NOT attisdropped
  ) THEN
    RAISE NOTICE '1226: kb_pages.source_article_id already absent - nothing to do';
    RETURN;
  END IF;

  IF to_regclass('public.kb_articles') IS NOT NULL THEN
    RAISE EXCEPTION '1226 precondition: public.kb_articles still exists - the cutover (1174) has not completed, so the bridge is still load-bearing';
  END IF;

  SELECT count(*) INTO bridged
  FROM "public"."kb_pages"
  WHERE "source_article_id" IS NOT NULL;

  IF bridged > 0 THEN
    RAISE EXCEPTION '1226 precondition: % kb_pages row(s) still carry source_article_id - the bridge is still in use and dropping it would lose the article provenance', bridged;
  END IF;

  DROP INDEX IF EXISTS "public"."uniq_kb_pages_org_source_article";

  ALTER TABLE "public"."kb_pages" DROP COLUMN "source_article_id";

  IF EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'public.kb_pages'::regclass
      AND attname = 'source_article_id' AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION '1226 postcondition failed: kb_pages.source_article_id survived the drop';
  END IF;
END $migration_1226$;
--> statement-breakpoint
