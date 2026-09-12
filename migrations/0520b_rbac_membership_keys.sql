SET lock_timeout = '5s';
--> statement-breakpoint
-- The RBAC grant tables key on the membership rather than the login:
-- role_assignments, user_permission_grants, principal_group_members and
-- module_ownerships were all moved that way. user_delegations and
-- user_module_access were moved on the shared database but never in a
-- migration, so the Drizzle declaration still named delegator_id, delegatee_id
-- and user_id while the database had membership columns.
--
-- Nothing caught it, because AccessService wrapped those reads in a
-- "table missing -> empty permission set" fallback whose matcher also accepts
-- 42703. A renamed column therefore read as an uninstalled module: permissions
-- silently resolved to the empty set, and -- because the failing statement
-- aborted the caller's transaction -- the next statement died naming some
-- entirely unrelated table. Every seeded e2e suite in the repo was red.
--
-- Keying on the membership is also the right shape: a grant hangs off the
-- person's place in the organisation, so it dies with the membership, and it
-- can carry the composite (org_id, membership_id) foreign key the rest of the
-- RBAC tables use. Keyed on the user id it outlived the membership and could
-- name a user from another tenant.
--
-- Every step is guarded: the shared database already has the target shape and
-- a freshly migrated one has none of it, so this must converge from both.

-- user_delegations ----------------------------------------------------------
ALTER TABLE "user_delegations" ADD COLUMN IF NOT EXISTS "delegator_membership_id" integer;
--> statement-breakpoint
ALTER TABLE "user_delegations" ADD COLUMN IF NOT EXISTS "delegatee_membership_id" integer;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'user_delegations'
       AND column_name = 'delegator_id'
  ) THEN
    EXECUTE $backfill$
      UPDATE user_delegations d
         SET delegator_membership_id = m.id
        FROM organization_members m
       WHERE m.org_id = d.org_id
         AND m.user_id = d.delegator_id
         AND d.delegator_membership_id IS NULL
    $backfill$;
    EXECUTE $backfill$
      UPDATE user_delegations d
         SET delegatee_membership_id = m.id
        FROM organization_members m
       WHERE m.org_id = d.org_id
         AND m.user_id = d.delegatee_id
         AND d.delegatee_membership_id IS NULL
    $backfill$;
  END IF;
END $$;
--> statement-breakpoint
-- A delegation naming somebody who is no longer a member of the organisation
-- cannot be expressed in the new key. It was already inert -- permission
-- resolution requires an active membership on both sides -- so removing it
-- discards nothing that was in force.
DELETE FROM "user_delegation_permissions"
 WHERE "delegation_id" IN (
   SELECT "id" FROM "user_delegations"
    WHERE "delegator_membership_id" IS NULL OR "delegatee_membership_id" IS NULL
 );
--> statement-breakpoint
DELETE FROM "user_delegations"
 WHERE "delegator_membership_id" IS NULL OR "delegatee_membership_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "user_delegations" DROP COLUMN IF EXISTS "delegator_id";
--> statement-breakpoint
ALTER TABLE "user_delegations" DROP COLUMN IF EXISTS "delegatee_id";
--> statement-breakpoint
ALTER TABLE "user_delegations" ALTER COLUMN "delegator_membership_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "user_delegations" ALTER COLUMN "delegatee_membership_id" SET NOT NULL;
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_user_delegations_delegatee_status";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_user_delegations_delegatee_status"
  ON "user_delegations" ("org_id", "delegatee_membership_id", "status");
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_user_delegations_delegator_membership'
  ) THEN
    ALTER TABLE "user_delegations"
      ADD CONSTRAINT "fk_user_delegations_delegator_membership"
      FOREIGN KEY ("org_id", "delegator_membership_id")
      REFERENCES "organization_members" ("org_id", "id") ON DELETE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_user_delegations_delegatee_membership'
  ) THEN
    ALTER TABLE "user_delegations"
      ADD CONSTRAINT "fk_user_delegations_delegatee_membership"
      FOREIGN KEY ("org_id", "delegatee_membership_id")
      REFERENCES "organization_members" ("org_id", "id") ON DELETE CASCADE NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "user_delegations" VALIDATE CONSTRAINT "fk_user_delegations_delegator_membership";
--> statement-breakpoint
ALTER TABLE "user_delegations" VALIDATE CONSTRAINT "fk_user_delegations_delegatee_membership";
--> statement-breakpoint

-- user_module_access --------------------------------------------------------
ALTER TABLE "user_module_access" ADD COLUMN IF NOT EXISTS "organization_membership_id" integer;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'user_module_access'
       AND column_name = 'user_id'
  ) THEN
    EXECUTE $backfill$
      UPDATE user_module_access a
         SET organization_membership_id = m.id
        FROM organization_members m
       WHERE m.org_id = a.org_id
         AND m.user_id = a.user_id
         AND a.organization_membership_id IS NULL
    $backfill$;
  END IF;
END $$;
--> statement-breakpoint
-- Same reasoning: a deny-override for somebody who is not a member denies
-- nothing, because the module gate never reaches it without a membership.
DELETE FROM "user_module_access" WHERE "organization_membership_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "user_module_access" DROP COLUMN IF EXISTS "user_id";
--> statement-breakpoint
ALTER TABLE "user_module_access" ALTER COLUMN "organization_membership_id" SET NOT NULL;
--> statement-breakpoint
DROP INDEX IF EXISTS "uniq_user_module_access_org_user_module";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_user_module_access_org_user";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_user_module_access_org_membership_module"
  ON "user_module_access" ("org_id", "organization_membership_id", "module_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_user_module_access_org_membership"
  ON "user_module_access" ("org_id", "organization_membership_id");
--> statement-breakpoint
-- The tenant key every RBAC table carries, and what a composite FK from a
-- child table would target.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uniq_user_module_access_org_id'
  ) THEN
    ALTER TABLE "user_module_access"
      ADD CONSTRAINT "uniq_user_module_access_org_id" UNIQUE ("org_id", "id");
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_user_module_access_membership'
  ) THEN
    ALTER TABLE "user_module_access"
      ADD CONSTRAINT "fk_user_module_access_membership"
      FOREIGN KEY ("org_id", "organization_membership_id")
      REFERENCES "organization_members" ("org_id", "id") ON DELETE CASCADE NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "user_module_access" VALIDATE CONSTRAINT "fk_user_module_access_membership";
