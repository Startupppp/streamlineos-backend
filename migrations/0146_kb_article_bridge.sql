ALTER TABLE "kb_pages" ADD COLUMN "source_article_id" integer;
CREATE UNIQUE INDEX "uniq_kb_pages_org_source_article" ON "kb_pages" ("org_id","source_article_id") WHERE "source_article_id" IS NOT NULL;
