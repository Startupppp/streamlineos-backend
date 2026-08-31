SET lock_timeout = '5s';

ALTER TABLE "user_delegations" ADD COLUMN IF NOT EXISTS "delegator_membership_id" integer;
--> statement-breakpoint
ALTER TABLE "user_delegations" ADD COLUMN IF NOT EXISTS "delegatee_membership_id" integer;
--> statement-breakpoint
ALTER TABLE "user_module_access" ADD COLUMN IF NOT EXISTS "organization_membership_id" integer;
--> statement-breakpoint

-- The backfill reads `delegator_id`/`delegatee_id`, and `0520_rbac_membership_keys`
-- performs the same contraction on the other lineage and drops them. On a cold
-- build where 0520 has already run, the columns are gone and there is nothing to
-- backfill: the rows this would have filled were filled there. Guarded on the
-- source columns existing, the same way every other expand step in this tranche
-- is guarded, so the file is correct in both orders.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'user_delegations'
      AND column_name = 'delegator_id'
  ) THEN
    EXECUTE $backfill$
      UPDATE "user_delegations" AS d
      SET "delegator_membership_id" = m."id"
      FROM "organization_members" AS m
      WHERE m."org_id" = d."org_id"
        AND m."user_id" = d."delegator_id"
        AND d."delegator_membership_id" IS NULL
    $backfill$;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'user_delegations'
      AND column_name = 'delegatee_id'
  ) THEN
    EXECUTE $backfill$
      UPDATE "user_delegations" AS d
      SET "delegatee_membership_id" = m."id"
      FROM "organization_members" AS m
      WHERE m."org_id" = d."org_id"
        AND m."user_id" = d."delegatee_id"
        AND d."delegatee_membership_id" IS NULL
    $backfill$;
  END IF;
END $$;
--> statement-breakpoint

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'user_module_access'
      AND column_name = 'user_id'
  ) THEN
    EXECUTE $backfill$
      UPDATE "user_module_access" AS a
      SET "organization_membership_id" = m."id"
      FROM "organization_members" AS m
      WHERE m."org_id" = a."org_id"
        AND m."user_id" = a."user_id"
        AND a."organization_membership_id" IS NULL
    $backfill$;
  END IF;
END $$;
--> statement-breakpoint

DO $$
DECLARE
  orphan_delegations integer;
  orphan_overrides integer;
BEGIN
  SELECT count(*) INTO orphan_delegations
  FROM "user_delegations"
  WHERE "delegator_membership_id" IS NULL OR "delegatee_membership_id" IS NULL;

  SELECT count(*) INTO orphan_overrides
  FROM "user_module_access"
  WHERE "organization_membership_id" IS NULL;

  IF orphan_delegations > 0 THEN
    RAISE WARNING 'user_delegations: % row(s) name a user with no membership in their organization. They are retained and reported; 0612 will refuse until they are resolved.', orphan_delegations;
  END IF;

  IF orphan_overrides > 0 THEN
    RAISE WARNING 'user_module_access: % row(s) name a user with no membership in their organization. They are retained and reported; 0612 will refuse until they are resolved.', orphan_overrides;
  END IF;
END $$;
