-- Migration: Consolidate duplicate org-structure tables into org_units + org_unit_members
-- DB is EMPTY for this deployment, so we CREATE the target shape and do not need to
-- preserve data from the old tables. Old tables are dropped at the end.

-- ─── New unified table ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "org_units" (
  "id"           text PRIMARY KEY,
  "org_id"       text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "kind"         text NOT NULL,
  "parent_id"    text REFERENCES "org_units"("id") ON DELETE SET NULL,
  "name"         text NOT NULL,
  "code"         text NOT NULL,
  "description"  text,
  "head_user_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "status"       text NOT NULL DEFAULT 'ACTIVE',
  "metadata"     jsonb,
  "created_at"   timestamp NOT NULL DEFAULT now(),
  "updated_at"   timestamp NOT NULL DEFAULT now(),
  "deleted_at"   timestamp
);

CREATE INDEX IF NOT EXISTS "idx_org_units_org_kind" ON "org_units" ("org_id", "kind");
CREATE INDEX IF NOT EXISTS "idx_org_units_parent"   ON "org_units" ("parent_id");
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_org_units_org_kind_code"
  ON "org_units" ("org_id", "kind", "code");

-- ─── New membership table ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "org_unit_members" (
  "id"          text PRIMARY KEY,
  "org_id"      text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "org_unit_id" text NOT NULL REFERENCES "org_units"("id") ON DELETE CASCADE,
  "user_id"     text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "role"        text NOT NULL DEFAULT 'member',
  "created_at"  timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_org_unit_members_unit_user"
  ON "org_unit_members" ("org_unit_id", "user_id");
CREATE INDEX IF NOT EXISTS "idx_org_unit_members_org_user"
  ON "org_unit_members" ("org_id", "user_id");
CREATE INDEX IF NOT EXISTS "idx_org_unit_members_unit"
  ON "org_unit_members" ("org_unit_id");

-- ─── Keep FK-anchor tables (non-owned consumers reference them) ───────────────
-- org_branches  : referenced by db/schema/crm/contacts.ts  (branches FK) and
--                 db/schema/inventory/warehouses.ts
-- org_departments: referenced by db/schema/hr/hiring.ts (orgDepartments FK)
-- These tables are NOT dropped so that non-owned schema files keep compiling.
-- They are no longer written to by org-hierarchy services (orgUnits replaces them);
-- existing rows are no longer inserted by application code.

-- ─── Drop consolidated old tables (DB is empty — no data to preserve) ─────────
-- Tables that have been fully migrated into org_units:

DROP TABLE IF EXISTS "org_business_units" CASCADE;
DROP TABLE IF EXISTS "org_teams"          CASCADE;
DROP TABLE IF EXISTS "org_locations"      CASCADE;
DROP TABLE IF EXISTS "org_cost_centers"   CASCADE;
DROP TABLE IF EXISTS "user_memberships"   CASCADE;
DROP TABLE IF EXISTS "hr_teams"           CASCADE;
