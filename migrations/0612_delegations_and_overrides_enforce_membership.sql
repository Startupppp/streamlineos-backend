SET lock_timeout = '5s';

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

  IF orphan_delegations > 0 OR orphan_overrides > 0 THEN
    RAISE EXCEPTION 'Unmapped rows remain: % delegation(s), % module override(s). Resolve them before enforcing the membership key; they are reported, not dropped.', orphan_delegations, orphan_overrides;
  END IF;
END $$;
--> statement-breakpoint

ALTER TABLE "user_delegations"
  ADD CONSTRAINT "chk_user_delegations_delegator_membership_present"
  CHECK ("delegator_membership_id" IS NOT NULL) NOT VALID;
--> statement-breakpoint
ALTER TABLE "user_delegations" VALIDATE CONSTRAINT "chk_user_delegations_delegator_membership_present";
--> statement-breakpoint
ALTER TABLE "user_delegations" ALTER COLUMN "delegator_membership_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "user_delegations" DROP CONSTRAINT "chk_user_delegations_delegator_membership_present";
--> statement-breakpoint

ALTER TABLE "user_delegations"
  ADD CONSTRAINT "chk_user_delegations_delegatee_membership_present"
  CHECK ("delegatee_membership_id" IS NOT NULL) NOT VALID;
--> statement-breakpoint
ALTER TABLE "user_delegations" VALIDATE CONSTRAINT "chk_user_delegations_delegatee_membership_present";
--> statement-breakpoint
ALTER TABLE "user_delegations" ALTER COLUMN "delegatee_membership_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "user_delegations" DROP CONSTRAINT "chk_user_delegations_delegatee_membership_present";
--> statement-breakpoint

ALTER TABLE "user_module_access"
  ADD CONSTRAINT "chk_user_module_access_membership_present"
  CHECK ("organization_membership_id" IS NOT NULL) NOT VALID;
--> statement-breakpoint
ALTER TABLE "user_module_access" VALIDATE CONSTRAINT "chk_user_module_access_membership_present";
--> statement-breakpoint
ALTER TABLE "user_module_access" ALTER COLUMN "organization_membership_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "user_module_access" DROP CONSTRAINT "chk_user_module_access_membership_present";
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_user_delegations_delegator_membership'
  ) THEN
    ALTER TABLE "user_delegations"
      ADD CONSTRAINT "fk_user_delegations_delegator_membership"
      FOREIGN KEY ("org_id", "delegator_membership_id")
      REFERENCES "organization_members" ("org_id", "id")
      ON DELETE CASCADE
      NOT VALID;
    ALTER TABLE "user_delegations" VALIDATE CONSTRAINT "fk_user_delegations_delegator_membership";
  END IF;
END $$;
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_user_delegations_delegatee_membership'
  ) THEN
    ALTER TABLE "user_delegations"
      ADD CONSTRAINT "fk_user_delegations_delegatee_membership"
      FOREIGN KEY ("org_id", "delegatee_membership_id")
      REFERENCES "organization_members" ("org_id", "id")
      ON DELETE CASCADE
      NOT VALID;
    ALTER TABLE "user_delegations" VALIDATE CONSTRAINT "fk_user_delegations_delegatee_membership";
  END IF;
END $$;
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_user_module_access_membership'
  ) THEN
    ALTER TABLE "user_module_access"
      ADD CONSTRAINT "fk_user_module_access_membership"
      FOREIGN KEY ("org_id", "organization_membership_id")
      REFERENCES "organization_members" ("org_id", "id")
      ON DELETE CASCADE
      NOT VALID;
    ALTER TABLE "user_module_access" VALIDATE CONSTRAINT "fk_user_module_access_membership";
  END IF;
END $$;
--> statement-breakpoint

DROP INDEX IF EXISTS "idx_user_delegations_delegatee_status";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_user_delegations_delegatee_status"
  ON "user_delegations" ("org_id", "delegatee_membership_id", "status");
--> statement-breakpoint

DROP INDEX IF EXISTS "uniq_user_module_access_org_user_module";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_user_module_access_org_membership_module"
  ON "user_module_access" ("org_id", "organization_membership_id", "module_key");
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_user_module_access_org_user";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_user_module_access_org_membership"
  ON "user_module_access" ("org_id", "organization_membership_id");
