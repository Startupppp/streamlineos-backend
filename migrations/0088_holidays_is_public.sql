-- Add is_public flag to holidays table to distinguish national vs org-specific holidays
ALTER TABLE "holidays" ADD COLUMN IF NOT EXISTS "is_public" boolean NOT NULL DEFAULT false;
