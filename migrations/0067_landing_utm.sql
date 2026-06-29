-- Add UTM tracking + IP + referrer columns to leads table
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "utm_source" TEXT;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "utm_medium" TEXT;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "utm_campaign" TEXT;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "utm_content" TEXT;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "utm_term" TEXT;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "ip_address" TEXT;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "referrer_url" TEXT;

-- Add slug, title, content, isPublished to landing_pages for public portal support
ALTER TABLE "landing_pages" ADD COLUMN IF NOT EXISTS "slug" TEXT;
ALTER TABLE "landing_pages" ADD COLUMN IF NOT EXISTS "title" TEXT;
ALTER TABLE "landing_pages" ADD COLUMN IF NOT EXISTS "content" TEXT;
ALTER TABLE "landing_pages" ADD COLUMN IF NOT EXISTS "is_published" BOOLEAN DEFAULT false;

-- Unique index on slug for fast public lookups
CREATE UNIQUE INDEX IF NOT EXISTS "idx_landing_pages_slug" ON "landing_pages" ("slug") WHERE "slug" IS NOT NULL;
