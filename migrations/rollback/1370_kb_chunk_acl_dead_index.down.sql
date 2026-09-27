SET lock_timeout = '5s';
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_kb_chunks_org_page_acl"
  ON "kb_article_chunks" ("org_id", "page_visibility", "page_project_id", "page_created_by_id", "page_created_by_membership_id")
  WHERE page_id IS NOT NULL;
