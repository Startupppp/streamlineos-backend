SET lock_timeout = '5s';
--> statement-breakpoint
DO $$ BEGIN
  ASSERT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'kb_page_purge_ledger'),
    'kb_page_purge_ledger must exist before widening the store constraint';
END $$;
--> statement-breakpoint
ALTER TABLE "kb_page_purge_ledger" DROP CONSTRAINT IF EXISTS "chk_kb_purge_ledger_store";
--> statement-breakpoint
ALTER TABLE "kb_page_purge_ledger" ADD CONSTRAINT "chk_kb_purge_ledger_store"
  CHECK (store IN ('visits', 'favorites', 'source_links', 'reviews', 'versions', 'comments', 'grants', 'chunks', 'analytics', 'notifications', 'caches', 'public_cdn', 'connector_projections', 'page_rows', 'blobs'));
--> statement-breakpoint
DO $$ BEGIN
  ASSERT EXISTS (SELECT 1 FROM information_schema.check_constraints WHERE constraint_name = 'chk_kb_purge_ledger_store'),
    'chk_kb_purge_ledger_store must exist after the constraint is re-added';
END $$;
