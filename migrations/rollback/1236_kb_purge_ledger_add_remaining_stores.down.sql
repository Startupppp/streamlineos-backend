SET lock_timeout = '5s';
DELETE FROM "kb_page_purge_ledger" WHERE store IN ('caches', 'public_cdn', 'connector_projections');
ALTER TABLE "kb_page_purge_ledger" DROP CONSTRAINT IF EXISTS "chk_kb_purge_ledger_store";
ALTER TABLE "kb_page_purge_ledger" ADD CONSTRAINT "chk_kb_purge_ledger_store"
  CHECK (store IN ('visits', 'favorites', 'source_links', 'reviews', 'versions', 'comments', 'grants', 'chunks', 'analytics', 'notifications', 'page_rows', 'blobs'));
