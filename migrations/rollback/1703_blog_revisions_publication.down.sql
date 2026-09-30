-- Reverses 1703. Dropping these tables and columns destroys every editorial revision, media
-- record, redirect and audit event written since 1703. The legacy columns of blog_posts still hold
-- the published projection, so the public site keeps serving what was last published.
SET lock_timeout = '5s';
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_blog_posts_scheduled";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_blog_posts_tags";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_blog_posts_public_search";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_blog_posts_public_order";
--> statement-breakpoint
DROP INDEX IF EXISTS "uq_blog_authors_slug";
--> statement-breakpoint
ALTER TABLE "blog_authors" DROP CONSTRAINT IF EXISTS "chk_blog_authors_slug_not_null";
--> statement-breakpoint
ALTER TABLE "blog_posts"
  DROP CONSTRAINT IF EXISTS "chk_blog_posts_schedule_pair",
  DROP CONSTRAINT IF EXISTS "fk_blog_posts_scheduled_revision",
  DROP CONSTRAINT IF EXISTS "fk_blog_posts_published_revision",
  DROP CONSTRAINT IF EXISTS "fk_blog_posts_working_revision";
--> statement-breakpoint
ALTER TABLE "blog_posts"
  DROP COLUMN IF EXISTS "cta_key",
  DROP COLUMN IF EXISTS "social_image",
  DROP COLUMN IF EXISTS "cover",
  DROP COLUMN IF EXISTS "search_text",
  DROP COLUMN IF EXISTS "standfirst",
  DROP COLUMN IF EXISTS "deleted_at",
  DROP COLUMN IF EXISTS "archived_at",
  DROP COLUMN IF EXISTS "modified_at",
  DROP COLUMN IF EXISTS "version",
  DROP COLUMN IF EXISTS "schedule_version",
  DROP COLUMN IF EXISTS "scheduled_for",
  DROP COLUMN IF EXISTS "scheduled_revision_id",
  DROP COLUMN IF EXISTS "published_revision_id",
  DROP COLUMN IF EXISTS "working_revision_id";
--> statement-breakpoint
ALTER TABLE "blog_categories"
  DROP COLUMN IF EXISTS "archived_at",
  DROP COLUMN IF EXISTS "seo_description",
  DROP COLUMN IF EXISTS "seo_title";
--> statement-breakpoint
ALTER TABLE "blog_authors" DROP COLUMN IF EXISTS "archived_at", DROP COLUMN IF EXISTS "slug";
--> statement-breakpoint
DROP TABLE IF EXISTS "blog_invalidation_receipts";
--> statement-breakpoint
DROP TABLE IF EXISTS "blog_rate_limits";
--> statement-breakpoint
DROP TABLE IF EXISTS "blog_audit_events";
--> statement-breakpoint
DROP TABLE IF EXISTS "blog_jobs";
--> statement-breakpoint
DROP TABLE IF EXISTS "blog_redirects";
--> statement-breakpoint
DROP TABLE IF EXISTS "blog_revision_media";
--> statement-breakpoint
DROP TABLE IF EXISTS "blog_post_revisions";
--> statement-breakpoint
DROP TABLE IF EXISTS "blog_media";
--> statement-breakpoint
DROP TABLE IF EXISTS "blog_editors";
--> statement-breakpoint
DROP TABLE IF EXISTS "blog_schema_meta";
