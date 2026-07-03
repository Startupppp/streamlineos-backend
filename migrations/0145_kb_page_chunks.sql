-- Make article_id nullable so chunks can belong to either an article or a wiki page.
--> statement-breakpoint
ALTER TABLE "kb_article_chunks" ALTER COLUMN "article_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "kb_article_chunks" ADD COLUMN IF NOT EXISTS "page_id" integer;
--> statement-breakpoint
ALTER TABLE "kb_article_chunks"
  ADD CONSTRAINT "kb_article_chunks_page_id_kb_pages_id_fk"
  FOREIGN KEY ("page_id") REFERENCES "kb_pages"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_kb_chunks_org_page" ON "kb_article_chunks" ("org_id", "page_id");
