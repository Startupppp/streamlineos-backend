SET lock_timeout = '5s';

DO $$
BEGIN
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'kb_page_purge_ledger'
  ), 'kb_page_purge_ledger table must exist before this migration';
END $$;

ALTER TABLE "kb_page_purge_ledger"
  DROP CONSTRAINT IF EXISTS "chk_kb_purge_ledger_store";

ALTER TABLE "kb_page_purge_ledger"
  ADD CONSTRAINT "chk_kb_purge_ledger_store"
  CHECK (store IN ('visits', 'favorites', 'source_links', 'page_rows', 'blobs', 'reviews'));

DO $$
BEGIN
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.check_constraints
    WHERE constraint_name = 'chk_kb_purge_ledger_store'
  ), 'chk_kb_purge_ledger_store constraint must exist after this migration';
END $$;
