SET lock_timeout = '5s';
--> statement-breakpoint
-- 0677: Forward-correct the kb_article_chunks acl_revision NOT NULL constraint.
--
-- Migration 0665 ran VALIDATE before the backfill, which is vacuously safe on
-- an empty table (as the dev DB was at apply time) but aborts on any DB that
-- has NULL rows in kb_article_chunks.
--
-- This migration is idempotent:
--   - If acl_revision is already NOT NULL, the DO block exits immediately.
--   - If acl_revision is still nullable, the correct order runs:
--       ADD CHECK NOT VALID, backfill UPDATE, VALIDATE, SET NOT NULL, DROP CHECK.
--   - Any orphaned CHECK constraint left by a partial 0665 run is dropped first.
--
-- No statement-breakpoint markers appear inside the DO block below.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'kb_article_chunks'
      AND column_name  = 'acl_revision'
      AND is_nullable  = 'YES'
  ) THEN
    IF EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = 'kb_article_chunks'::regclass
        AND conname  = 'chk_kb_article_chunks_acl_revision_not_null'
    ) THEN
      ALTER TABLE kb_article_chunks
        DROP CONSTRAINT chk_kb_article_chunks_acl_revision_not_null;
    END IF;

    ALTER TABLE kb_article_chunks
      ADD CONSTRAINT chk_kb_acl_revision_nn_fwd
      CHECK (acl_revision IS NOT NULL) NOT VALID;

    UPDATE kb_article_chunks SET acl_revision = 1 WHERE acl_revision IS NULL;

    ALTER TABLE kb_article_chunks
      VALIDATE CONSTRAINT chk_kb_acl_revision_nn_fwd;

    ALTER TABLE kb_article_chunks ALTER COLUMN acl_revision SET NOT NULL;

    ALTER TABLE kb_article_chunks ALTER COLUMN acl_revision SET DEFAULT 1;

    ALTER TABLE kb_article_chunks
      DROP CONSTRAINT chk_kb_acl_revision_nn_fwd;
  END IF;
END $$;
