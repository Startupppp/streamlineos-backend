SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'organizations'
  ), 'organizations table must exist in public before this migration';
END $$;
--> statement-breakpoint

ALTER TABLE "organizations"
  ADD COLUMN IF NOT EXISTS "roadmap_public_token" text;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "uq_organizations_roadmap_public_token"
  ON "organizations" ("roadmap_public_token")
  WHERE "roadmap_public_token" IS NOT NULL;
--> statement-breakpoint

DO $$
BEGIN
  ASSERT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'organizations'
      AND column_name = 'roadmap_public_token'
  ), 'roadmap_public_token column must exist after this migration';
  ASSERT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'organizations'
      AND indexname = 'uq_organizations_roadmap_public_token'
  ), 'uq_organizations_roadmap_public_token must exist after this migration';
  ASSERT (
    SELECT is_nullable FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'organizations'
      AND column_name = 'roadmap_public_token'
  ) = 'YES', 'roadmap_public_token must stay nullable so an unpublished organization needs no backfill';
END $$;
