-- Add settings JSONB column to landing_pages for testimonials, trust badges, etc.
ALTER TABLE "landing_pages" ADD COLUMN IF NOT EXISTS "settings" jsonb;
