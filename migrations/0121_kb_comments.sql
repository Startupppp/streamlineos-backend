-- Migrate kb_article_comments to new schema (rename columns, add threading + resolve)
ALTER TABLE "kb_article_comments" RENAME COLUMN "user_id" TO "author_id";
ALTER TABLE "kb_article_comments" RENAME COLUMN "body" TO "content";
ALTER TABLE "kb_article_comments" ADD COLUMN IF NOT EXISTS "parent_id" integer;
ALTER TABLE "kb_article_comments" ADD COLUMN IF NOT EXISTS "resolved_at" timestamp;
CREATE INDEX IF NOT EXISTS "idx_kb_comments_org_article" ON "kb_article_comments" ("org_id", "article_id");
