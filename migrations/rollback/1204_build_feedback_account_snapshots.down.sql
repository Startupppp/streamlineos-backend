SET lock_timeout = '5s';
--> statement-breakpoint

DROP INDEX IF EXISTS "build"."idx_feedback_posts_org_tier_snapshot";
--> statement-breakpoint

ALTER TABLE "build"."feedback_posts"
  DROP COLUMN IF EXISTS "account_tier_snapshot";
