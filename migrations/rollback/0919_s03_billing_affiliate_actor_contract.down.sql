-- Rollback 0919: restore the pre-contract affiliate schema.
-- This rollback refuses to coerce a non-numeric historical user id.

SET lock_timeout = '5s';

--> statement-breakpoint
ALTER TABLE "affiliates" DROP CONSTRAINT IF EXISTS "fk_affiliates_org_user_mbr";

--> statement-breakpoint
DROP INDEX IF EXISTS "affiliates_org_mbr_idx";

--> statement-breakpoint
ALTER TABLE "affiliates" DROP COLUMN IF EXISTS "user_membership_id";

--> statement-breakpoint
DO $$
DECLARE non_numeric_count bigint;
BEGIN
  SELECT count(*) INTO non_numeric_count
  FROM "affiliates"
  WHERE "user_id" !~ '^[0-9]+$';
  IF non_numeric_count > 0 THEN
    RAISE EXCEPTION '0919 rollback blocked: % affiliate user_id value(s) are not numeric', non_numeric_count;
  END IF;
END $$;

--> statement-breakpoint
ALTER TABLE "affiliates" ALTER COLUMN "user_id" TYPE integer USING "user_id"::integer;
