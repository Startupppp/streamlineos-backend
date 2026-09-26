SET lock_timeout = '5s';
--> statement-breakpoint

ALTER TABLE "public"."kb_pages"
  ADD COLUMN IF NOT EXISTS "acl_revision_changed_at" timestamptz;
--> statement-breakpoint

ALTER TABLE "public"."kb_article_chunks"
  ADD COLUMN IF NOT EXISTS "acl_synced_at" timestamptz;
