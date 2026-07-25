ALTER TABLE "kb_articles" ADD COLUMN IF NOT EXISTS "fts" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('english', coalesce(title, '')), 'A') || setweight(to_tsvector('english', coalesce(excerpt, '')), 'B') || setweight(to_tsvector('english', coalesce(content_text, '')), 'C')) STORED;--> statement-breakpoint
ALTER TABLE "kb_pages" ADD COLUMN IF NOT EXISTS "fts" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('english', coalesce(title, '')), 'A') || setweight(to_tsvector('english', coalesce(content_text, '')), 'B')) STORED;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_kb_page_comments_parent') THEN
    ALTER TABLE "kb_page_comments" ADD CONSTRAINT "fk_kb_page_comments_parent" FOREIGN KEY ("parent_id") REFERENCES "public"."kb_page_comments"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_kb_articles_fts" ON "kb_articles" USING gin ("fts");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_kb_pages_fts" ON "kb_pages" USING gin ("fts");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_kb_chunks_embedding_hnsw" ON "kb_article_chunks" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_wsc_embedding_hnsw" ON "workspace_search_chunks" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_wsc_fts_gin" ON "workspace_search_chunks" USING gin ("fts");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_kb_space_members_org_space" ON "kb_space_members" USING btree ("org_id","space_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_kb_article_restrictions_org_article" ON "kb_article_restrictions" USING btree ("org_id","article_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_kb_article_versions_org_article" ON "kb_article_versions" USING btree ("org_id","article_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_kb_article_translations_org_article" ON "kb_article_translations" USING btree ("org_id","article_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_kb_page_versions_org_page" ON "kb_page_versions" USING btree ("org_id","page_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_kb_page_comments_parent" ON "kb_page_comments" USING btree ("parent_id");
