SET lock_timeout = '5s';

DROP INDEX CONCURRENTLY IF EXISTS "idx_kb_pages_org_legal_hold";

ALTER TABLE "kb_pages"
  DROP COLUMN IF EXISTS "legal_hold_reason",
  DROP COLUMN IF EXISTS "legal_hold";
