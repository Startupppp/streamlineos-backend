-- 0919: Contract the Billing affiliate authority pointer to organization_members.
-- affiliates.user_id remains as an immutable historical display identity.
-- The migration stops before cutover if any affiliate cannot be mapped exactly.

SET lock_timeout = '5s';

--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'affiliates'
      AND column_name = 'user_id'
      AND data_type <> 'text'
  ) THEN
    ALTER TABLE "affiliates" ALTER COLUMN "user_id" TYPE text USING "user_id"::text;
  END IF;
END $$;

--> statement-breakpoint
UPDATE "affiliates" a
SET "user_membership_id" = om.id
FROM "organization_members" om
WHERE om.org_id = a.org_id
  AND om.user_id = a.user_id
  AND a.user_membership_id IS NULL;

--> statement-breakpoint
DO $$
DECLARE unmappable_count bigint;
BEGIN
  SELECT count(*) INTO unmappable_count
  FROM "affiliates"
  WHERE "user_membership_id" IS NULL;
  IF unmappable_count > 0 THEN
    RAISE EXCEPTION '0919 blocked: % affiliate authority row(s) cannot map to an organization membership', unmappable_count;
  END IF;
END $$;

--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_affiliates_org_user_mbr'
      AND conrelid = 'affiliates'::regclass
  ) THEN
    ALTER TABLE "affiliates"
      ADD CONSTRAINT "fk_affiliates_org_user_mbr"
      FOREIGN KEY ("org_id", "user_membership_id")
      REFERENCES "organization_members" ("org_id", "id")
      ON DELETE SET NULL ("user_membership_id")
      NOT VALID;
  END IF;
END $$;

--> statement-breakpoint
ALTER TABLE "affiliates" VALIDATE CONSTRAINT "fk_affiliates_org_user_mbr";

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "affiliates_org_mbr_idx"
  ON "affiliates" ("org_id", "user_membership_id");
