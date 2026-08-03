SET statement_timeout = 0;

-- =============================================================================
-- 0373 — one typed home for record-level access
-- =============================================================================
-- Per-object access is spread across a dozen bespoke tables, each with its own
-- principal shape: some grant to a user, some to a free-text role string, some
-- to a team string, and none share a level vocabulary. "What can this person
-- reach?" therefore needs a union across a dozen queries, and a role-string
-- grant can silently stop matching anyone when the role vocabulary changes —
-- which is exactly what happened to the KB grants during the role collapse.
--
-- Additive only. Nothing reads this table yet; existing grant tables keep
-- working untouched, so migrating a resource type onto it is a per-type
-- decision that can be made and verified one at a time.
--
-- resource_id is TEXT so both integer and uuid primary keys fit without a
-- column per resource type.
-- =============================================================================

CREATE TABLE IF NOT EXISTS "resource_grants" (
  "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id"         text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "resource_type"  text NOT NULL,
  "resource_id"    text NOT NULL,
  "principal_type" text NOT NULL,
  "principal_id"   text NOT NULL,
  "level"          text NOT NULL,
  "granted_by"     text REFERENCES "users"("id") ON DELETE SET NULL,
  "expires_at"     timestamptz,
  "created_at"     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "resource_grants_principal_type_check"
    CHECK ("principal_type" IN ('user', 'org_membership', 'principal_group', 'role'))
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_resource_grants_principal"
  ON "resource_grants" ("org_id", "resource_type", "resource_id", "principal_type", "principal_id");
--> statement-breakpoint

-- "who can see this record?"
CREATE INDEX IF NOT EXISTS "idx_resource_grants_resource"
  ON "resource_grants" ("org_id", "resource_type", "resource_id");
--> statement-breakpoint

-- "what can this principal see?" — the question the bespoke tables cannot answer
CREATE INDEX IF NOT EXISTS "idx_resource_grants_principal"
  ON "resource_grants" ("org_id", "principal_type", "principal_id");
