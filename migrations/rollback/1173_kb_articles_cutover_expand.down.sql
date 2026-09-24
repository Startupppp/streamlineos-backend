SET lock_timeout = '5s';
--> statement-breakpoint

-- Remove kb_pages rows that were backfilled from kb_articles by this migration.
-- Rows that already existed before the migration (source_article_id was set via
-- the TypeScript service) are indistinguishable from rows the backfill inserted,
-- so this rollback removes ALL pages whose source_article_id is non-null.
-- If you ran the TypeScript migration service before 1173, those pages will be
-- removed here too and must be recreated by re-running the service.
DELETE FROM "public"."kb_pages"
WHERE "source_article_id" IS NOT NULL;
