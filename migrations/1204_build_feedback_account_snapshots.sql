SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF to_regclass('build.feedback_posts') IS NULL THEN
    RAISE EXCEPTION '1204 precondition: build.feedback_posts is absent';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typnamespace = 'public'::regnamespace AND typname = 'crm_account_tier') THEN
    RAISE EXCEPTION '1204 precondition: public.crm_account_tier is absent';
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "build"."feedback_posts"
  ADD COLUMN IF NOT EXISTS "account_tier_snapshot" "public"."crm_account_tier";
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_feedback_posts_org_tier_snapshot"
  ON "build"."feedback_posts" ("org_id", "account_tier_snapshot")
  WHERE "deleted_at" IS NULL AND "account_tier_snapshot" IS NOT NULL;
