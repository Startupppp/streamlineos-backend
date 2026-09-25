SET lock_timeout = '5s';

ALTER TABLE "public"."kb_article_chunks"
  DROP COLUMN IF EXISTS "acl_synced_at";

ALTER TABLE "public"."kb_pages"
  DROP COLUMN IF EXISTS "acl_revision_changed_at";
