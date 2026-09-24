-- @data-loss
-- Drops kb_articles and its dependent tables. The rollback recreates structure
-- only; rows are recoverable from PITR alone, and that window is 1 day.
-- Do not run until verify/1173_kb_articles_cutover_parity.sql reports zero rows
-- in all three of its queries.
SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
DECLARE
  unmatched_count   integer;
  col_mismatch_count integer;
BEGIN
  IF to_regclass('public.kb_articles') IS NULL THEN
    RAISE EXCEPTION '1174 precondition: public.kb_articles is absent — was 1174 already applied?';
  END IF;

  SELECT count(*) INTO unmatched_count
  FROM "public"."kb_articles" a
  WHERE NOT EXISTS (
    SELECT 1 FROM "public"."kb_pages" p
    WHERE p.org_id = a.org_id
      AND p.source_article_id = a.id
  );

  IF unmatched_count > 0 THEN
    RAISE EXCEPTION '1174 precondition: % kb_articles row(s) have no matching kb_pages row — run 1173 and verify parity before this migration', unmatched_count;
  END IF;

  SELECT count(*) INTO col_mismatch_count
  FROM "public"."kb_articles" a
  JOIN "public"."kb_pages" p
    ON p.org_id = a.org_id AND p.source_article_id = a.id
  WHERE a.slug               IS DISTINCT FROM p.slug
     OR a.title              IS DISTINCT FROM p.title
     OR a.excerpt            IS DISTINCT FROM p.excerpt
     OR a.views              IS DISTINCT FROM p.views
     OR a.helpful_count      IS DISTINCT FROM p.helpful_count
     OR a.not_helpful_count  IS DISTINCT FROM p.not_helpful_count
     OR a.seo_title          IS DISTINCT FROM p.seo_title
     OR a.seo_description    IS DISTINCT FROM p.seo_description
     OR a.review_interval_days IS DISTINCT FROM p.review_interval_days
     OR a.published_at       IS DISTINCT FROM p.published_at
     OR a.archived_at        IS DISTINCT FROM p.archived_at;

  IF col_mismatch_count > 0 THEN
    RAISE EXCEPTION '1174 precondition: % article/page pair(s) have column-level mismatches — run verify/1173_kb_articles_cutover_parity.sql to identify them', col_mismatch_count;
  END IF;
END $$;
--> statement-breakpoint

-- Drop the FK from kb_article_chunks to kb_article_attachments before
-- we drop kb_article_attachments. The chunks table is kept because it also
-- holds page and source chunks.
ALTER TABLE "public"."kb_article_chunks"
  DROP CONSTRAINT IF EXISTS "fk_kb_chunks_org_attachment";
--> statement-breakpoint

ALTER TABLE "public"."kb_article_chunks"
  DROP CONSTRAINT IF EXISTS "fk_kb_chunks_org_article";
--> statement-breakpoint

-- Drop article-only dependent tables. Order matters: child tables before parents.
DROP TABLE IF EXISTS "public"."kb_article_feedback";
--> statement-breakpoint

DROP TABLE IF EXISTS "public"."kb_article_restrictions";
--> statement-breakpoint

DROP TABLE IF EXISTS "public"."kb_article_tags";
--> statement-breakpoint

DROP TABLE IF EXISTS "public"."kb_article_versions";
--> statement-breakpoint

DROP TABLE IF EXISTS "public"."kb_article_translations";
--> statement-breakpoint

DROP TABLE IF EXISTS "public"."kb_article_attachments";
--> statement-breakpoint

-- kb_article_comments has a self-referential FK (parent_id) which Postgres
-- resolves internally when the table itself is dropped.
DROP TABLE IF EXISTS "public"."kb_article_comments";
--> statement-breakpoint

-- Drop SET-NULL FK constraints on tables we keep, so they no longer block the
-- DROP TABLE below.
ALTER TABLE "public"."kb_events"
  DROP CONSTRAINT IF EXISTS "fk_kb_events_org_article";
--> statement-breakpoint

ALTER TABLE "public"."kb_pages"
  DROP CONSTRAINT IF EXISTS "fk_kb_pages_org_source_article";
--> statement-breakpoint

ALTER TABLE "public"."support_knowledge_gaps"
  DROP CONSTRAINT IF EXISTS "fk_support_knowledge_gaps_proposed_article_id_org";
--> statement-breakpoint

-- Drop the articles table. CASCADE drops any remaining dependent objects
-- (index descriptors, enum usages in the column definitions).
DROP TABLE "public"."kb_articles";
--> statement-breakpoint

-- Drop the article-only enum types that are now orphaned.
DROP TYPE IF EXISTS "public"."kb_article_status";
--> statement-breakpoint

DROP TYPE IF EXISTS "public"."kb_article_visibility";
