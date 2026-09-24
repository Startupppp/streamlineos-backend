SET lock_timeout = '5s';
--> statement-breakpoint

-- Drop the category FK before dropping the column it references.
ALTER TABLE "public"."kb_pages" DROP CONSTRAINT IF EXISTS "fk_kb_pages_org_category";
--> statement-breakpoint

DROP INDEX IF EXISTS "uniq_kb_pages_org_slug_ref";
--> statement-breakpoint

ALTER TABLE "public"."kb_pages"
  DROP COLUMN IF EXISTS "slug",
  DROP COLUMN IF EXISTS "excerpt",
  DROP COLUMN IF EXISTS "category_id",
  DROP COLUMN IF EXISTS "views",
  DROP COLUMN IF EXISTS "helpful_count",
  DROP COLUMN IF EXISTS "not_helpful_count",
  DROP COLUMN IF EXISTS "seo_title",
  DROP COLUMN IF EXISTS "seo_description",
  DROP COLUMN IF EXISTS "review_interval_days",
  DROP COLUMN IF EXISTS "published_at",
  DROP COLUMN IF EXISTS "archived_at";
