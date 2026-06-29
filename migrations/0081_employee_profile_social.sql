-- Employee profile: bio + social links
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "bio" text;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "linkedin_url" text;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "twitter_url" text;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "github_url" text;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "website_url" text;
