-- 0328_membership_role_assignments.sql
-- Adds membership_role_assignments: roles assigned to organization memberships
-- rather than bare user IDs, enabling the eventual retirement of users.role.
-- Idempotent: uses IF NOT EXISTS / DO blocks with duplicate-object guards.

CREATE TABLE IF NOT EXISTS "membership_role_assignments" (
  "id"                        SERIAL PRIMARY KEY,
  "organization_id"           TEXT NOT NULL,
  "organization_membership_id" INTEGER NOT NULL,
  "role_id"                   INTEGER NOT NULL,
  "assigned_by"               TEXT,
  "created_at"                TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_mra_org_membership_role"
  ON "membership_role_assignments" ("organization_id", "organization_membership_id", "role_id");

CREATE INDEX IF NOT EXISTS "idx_mra_org_membership"
  ON "membership_role_assignments" ("organization_id", "organization_membership_id");

DO $$ BEGIN
  ALTER TABLE "membership_role_assignments"
    ADD CONSTRAINT "mra_org_fk"
    FOREIGN KEY ("organization_id")
    REFERENCES "organizations"("id")
    ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "membership_role_assignments"
    ADD CONSTRAINT "mra_role_fk"
    FOREIGN KEY ("role_id")
    REFERENCES "roles"("id")
    ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "membership_role_assignments"
    ADD CONSTRAINT "mra_assigned_by_fk"
    FOREIGN KEY ("assigned_by")
    REFERENCES "users"("id")
    ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Composite FK: (organization_id, organization_membership_id) ->
-- organization_members(org_id, id), enabled by unique("uniq_org_members_org_id")
DO $$ BEGIN
  ALTER TABLE "membership_role_assignments"
    ADD CONSTRAINT "mra_composite_membership_fk"
    FOREIGN KEY ("organization_id", "organization_membership_id")
    REFERENCES "organization_members"("org_id", "id")
    ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
