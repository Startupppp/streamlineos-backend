SET lock_timeout = '5s';
--> statement-breakpoint

DELETE FROM "kb_page_purge_ledger"
  WHERE store IN ('versions', 'comments', 'grants', 'chunks', 'analytics', 'notifications');
--> statement-breakpoint

ALTER TABLE "kb_page_purge_ledger"
  DROP CONSTRAINT IF EXISTS "chk_kb_purge_ledger_store";
--> statement-breakpoint

ALTER TABLE "kb_page_purge_ledger"
  ADD CONSTRAINT "chk_kb_purge_ledger_store"
  CHECK (store IN ('visits', 'favorites', 'source_links', 'reviews', 'page_rows', 'blobs'));
