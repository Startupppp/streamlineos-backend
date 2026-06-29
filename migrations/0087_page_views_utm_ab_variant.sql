-- Add UTM tracking and A/B variant to page_views
ALTER TABLE "page_views" ADD COLUMN IF NOT EXISTS "utm_source" text;
ALTER TABLE "page_views" ADD COLUMN IF NOT EXISTS "utm_medium" text;
ALTER TABLE "page_views" ADD COLUMN IF NOT EXISTS "utm_campaign" text;
ALTER TABLE "page_views" ADD COLUMN IF NOT EXISTS "ab_variant" text;
