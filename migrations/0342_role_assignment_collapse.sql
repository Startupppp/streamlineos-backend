SET statement_timeout = 0;
-- 0342 — role_assignment_collapse
-- Collapses user_roles (userId-keyed) and membership_role_assignments
-- (membershipId-keyed) into a single role_assignments table keyed exclusively
-- by organization_membership_id. A single authoritative source closes the
-- stale-access gap: revoking a row from either old table could leave access
-- alive via the other. Backfills for non-empty environments; the live DB is
-- EMPTY so the INSERT ... SELECT clauses run as no-ops on a fresh build.

CREATE TABLE IF NOT EXISTS "role_assignments" (
  "id"                          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id"                      TEXT         NOT NULL,
  "organization_membership_id"  INTEGER      NOT NULL,
  "role_id"                     INTEGER      NOT NULL,
  "assigned_by_membership_id"   INTEGER,
  "expires_at"                  TIMESTAMPTZ,
  "reason"                      TEXT,
  "created_at"                  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_role_assignments_org_membership_role"
  ON "role_assignments" ("org_id", "organization_membership_id", "role_id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_role_assignments_org_membership"
  ON "role_assignments" ("org_id", "organization_membership_id");
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "role_assignments"
    ADD CONSTRAINT "ra_org_fk"
    FOREIGN KEY ("org_id")
    REFERENCES "organizations"("id")
    ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "role_assignments"
    ADD CONSTRAINT "ra_role_fk"
    FOREIGN KEY ("role_id")
    REFERENCES "roles"("id")
    ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

-- Composite FK: (org_id, organization_membership_id) references
-- organization_members(org_id, id) via the unique("uniq_org_members_org_id")
-- constraint. ON DELETE CASCADE removes assignments when a membership is deleted.
DO $$ BEGIN
  ALTER TABLE "role_assignments"
    ADD CONSTRAINT "ra_membership_fk"
    FOREIGN KEY ("org_id", "organization_membership_id")
    REFERENCES "organization_members"("org_id", "id")
    ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint

-- Backfill from membership_role_assignments (preferred source: already
-- membership-keyed, no join needed).
INSERT INTO "role_assignments" (
  "id",
  "org_id",
  "organization_membership_id",
  "role_id",
  "assigned_by_membership_id",
  "created_at"
)
SELECT
  gen_random_uuid(),
  mra."organization_id",
  mra."organization_membership_id",
  mra."role_id",
  NULL,
  mra."created_at"
FROM "membership_role_assignments" mra
ON CONFLICT ("org_id", "organization_membership_id", "role_id") DO NOTHING;
--> statement-breakpoint

-- Backfill from user_roles for any (membership, role) pair not already covered.
-- Preserves expires_at, which membership_role_assignments did not carry.
INSERT INTO "role_assignments" (
  "id",
  "org_id",
  "organization_membership_id",
  "role_id",
  "assigned_by_membership_id",
  "expires_at",
  "created_at"
)
SELECT
  gen_random_uuid(),
  ur."org_id",
  om."id",
  ur."role_id",
  NULL,
  ur."expires_at",
  ur."created_at"
FROM "user_roles" ur
INNER JOIN "organization_members" om
  ON om."user_id" = ur."user_id"
  AND om."org_id" = ur."org_id"
ON CONFLICT ("org_id", "organization_membership_id", "role_id") DO NOTHING;
--> statement-breakpoint

DROP TABLE IF EXISTS "membership_role_assignments" CASCADE;
--> statement-breakpoint

DROP TABLE IF EXISTS "user_roles" CASCADE;
