SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE kb_article_chunks
  ADD CONSTRAINT chk_kb_article_chunks_acl_revision_not_null CHECK (acl_revision IS NOT NULL) NOT VALID;
--> statement-breakpoint
ALTER TABLE kb_article_chunks
  VALIDATE CONSTRAINT chk_kb_article_chunks_acl_revision_not_null;
--> statement-breakpoint
UPDATE kb_article_chunks SET acl_revision = 1 WHERE acl_revision IS NULL;
--> statement-breakpoint
ALTER TABLE kb_article_chunks ALTER COLUMN acl_revision SET NOT NULL;
--> statement-breakpoint
ALTER TABLE kb_article_chunks ALTER COLUMN acl_revision SET DEFAULT 1;
--> statement-breakpoint
ALTER TABLE kb_article_chunks
  DROP CONSTRAINT chk_kb_article_chunks_acl_revision_not_null;
