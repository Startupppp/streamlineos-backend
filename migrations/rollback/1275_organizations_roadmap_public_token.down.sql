SET lock_timeout = '5s';
--> statement-breakpoint

DROP INDEX IF EXISTS "uq_organizations_roadmap_public_token";
--> statement-breakpoint

ALTER TABLE "organizations"
  DROP COLUMN IF EXISTS "roadmap_public_token";
--> statement-breakpoint

DO $$
BEGIN
  ASSERT NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'organizations' AND column_name = 'roadmap_public_token'
  ), 'roadmap_public_token column must be gone after rollback';
END $$;
