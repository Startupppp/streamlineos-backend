SET lock_timeout = '5s';
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'magic_link_tokens' AND column_name = 'org_id'
  ) THEN
    RAISE EXCEPTION '1365-rollback precondition: magic_link_tokens.org_id is already absent';
  END IF;
END $$;
--> statement-breakpoint

DROP INDEX IF EXISTS "idx_magic_link_tokens_org";
--> statement-breakpoint

ALTER TABLE "magic_link_tokens" DROP CONSTRAINT IF EXISTS "magic_link_tokens_org_id_organizations_id_fk";
--> statement-breakpoint

ALTER TABLE "magic_link_tokens" DROP COLUMN "org_id";
