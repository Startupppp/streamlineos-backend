-- 0825_portal_auth_owner_drop
-- Drop the AUTHORITY legacy users.id column from portal_memberships now that:
--   • companion user_membership_id exists and FK is validated (migration 0820)
--   • portal-access service reads/writes use user_membership_id
--
-- Column dropped:
--   portal_memberships   user_id  (AUTH — portal access identity)

SET lock_timeout = '5s';
--> statement-breakpoint

-- Pre-flight: companion FK must be validated
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_portal_memberships_user_membership'
      AND contype = 'f'
      AND convalidated
  ) THEN
    RAISE EXCEPTION '0825: fk_portal_memberships_user_membership not validated — run 0820 first';
  END IF;
END $$;
--> statement-breakpoint

-- Safety: unmapped AUTH rows
DO $$
DECLARE
  unmapped bigint;
BEGIN
  SELECT count(*) INTO unmapped
  FROM portal_memberships
  WHERE user_id IS NOT NULL AND user_membership_id IS NULL;

  IF unmapped > 0 THEN
    RAISE EXCEPTION '0825: % portal_memberships rows have user_id set but no user_membership_id — backfill or investigate before drop', unmapped;
  END IF;
END $$;
--> statement-breakpoint

-- Drop FK then column
ALTER TABLE portal_memberships DROP CONSTRAINT IF EXISTS portal_memberships_user_id_fkey;
--> statement-breakpoint
ALTER TABLE portal_memberships DROP COLUMN IF EXISTS user_id;
--> statement-breakpoint

-- Post-flight
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'portal_memberships' AND column_name = 'user_id'
  ) THEN
    RAISE EXCEPTION '0825: portal_memberships.user_id still present after drop';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'portal_memberships' AND column_name = 'user_membership_id'
  ) THEN
    RAISE EXCEPTION '0825: portal_memberships.user_membership_id companion missing';
  END IF;
END $$;
