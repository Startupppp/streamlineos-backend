SET statement_timeout = 0;

-- ─── Part 1a: Retire org_branches → re-anchor warehouse FK to org_units ────────
-- inv_warehouses.branch_id is a text FK → org_branches.id (text).
-- DROP CASCADE removes the FK constraint from inv_warehouses automatically.
-- We then re-add it pointing at org_units (same text PK type, zero data migration needed).

DROP TABLE IF EXISTS "org_branches" CASCADE;

ALTER TABLE "inv_warehouses"
  ADD CONSTRAINT "inv_warehouses_branch_id_org_units_id_fk"
  FOREIGN KEY ("branch_id") REFERENCES "org_units"("id") ON DELETE SET NULL;

-- ─── Part 1b: Retire org_departments → re-anchor three FKs to org_units ────────
-- job_postings.org_department_id    text FK → org_departments.id
-- headcount_requests.org_department_id  text FK → org_departments.id
-- onboarding_templates.department_id    text FK → org_departments.id
-- DROP CASCADE removes all three FK constraints automatically.

DROP TABLE IF EXISTS "org_departments" CASCADE;

ALTER TABLE "job_postings"
  ADD CONSTRAINT "job_postings_org_department_id_org_units_id_fk"
  FOREIGN KEY ("org_department_id") REFERENCES "org_units"("id") ON DELETE SET NULL;

ALTER TABLE "headcount_requests"
  ADD CONSTRAINT "headcount_requests_org_department_id_org_units_id_fk"
  FOREIGN KEY ("org_department_id") REFERENCES "org_units"("id") ON DELETE SET NULL;

ALTER TABLE "onboarding_templates"
  ADD CONSTRAINT "onboarding_templates_department_id_org_units_id_fk"
  FOREIGN KEY ("department_id") REFERENCES "org_units"("id") ON DELETE SET NULL;

-- ─── Part 2: Typed principal-group tables (replaces polymorphic group_roles) ────
-- group_roles uses integer group_id + group_type enum with no real FK.
-- The new tables carry real FK constraints and a discriminated kind column.
-- group_roles is NOT dropped here: modules/rbac/** still writes to it.
-- Drain group_roles → group_role_assignments and drop group_roles in a
-- separate migration once the rbac module is updated.

CREATE TABLE IF NOT EXISTS "principal_groups" (
  "id"           uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  "org_id"       text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "kind"         text NOT NULL,
  "org_unit_id"  text REFERENCES "org_units"("id") ON DELETE CASCADE,
  "name"         text NOT NULL,
  "created_at"   timestamp NOT NULL DEFAULT now(),
  "updated_at"   timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_principal_groups_org_name"
  ON "principal_groups"("org_id", "name");
CREATE INDEX IF NOT EXISTS "idx_principal_groups_org"
  ON "principal_groups"("org_id");
CREATE INDEX IF NOT EXISTS "idx_principal_groups_org_unit"
  ON "principal_groups"("org_unit_id");

CREATE TABLE IF NOT EXISTS "principal_group_members" (
  "id"                          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  "org_id"                      text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "principal_group_id"          uuid NOT NULL REFERENCES "principal_groups"("id") ON DELETE CASCADE,
  "organization_membership_id"  integer NOT NULL,
  "created_at"                  timestamp NOT NULL DEFAULT now(),
  FOREIGN KEY ("org_id", "organization_membership_id")
    REFERENCES "organization_members"("org_id", "id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_principal_group_members_group_member"
  ON "principal_group_members"("principal_group_id", "organization_membership_id");
CREATE INDEX IF NOT EXISTS "idx_principal_group_members_org_member"
  ON "principal_group_members"("org_id", "organization_membership_id");
CREATE INDEX IF NOT EXISTS "idx_principal_group_members_group"
  ON "principal_group_members"("principal_group_id");

CREATE TABLE IF NOT EXISTS "group_role_assignments" (
  "id"                   uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  "org_id"               text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "principal_group_id"   uuid NOT NULL REFERENCES "principal_groups"("id") ON DELETE CASCADE,
  "role_id"              integer NOT NULL REFERENCES "roles"("id") ON DELETE CASCADE,
  "created_at"           timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_group_role_assignments_group_role"
  ON "group_role_assignments"("org_id", "principal_group_id", "role_id");
CREATE INDEX IF NOT EXISTS "idx_group_role_assignments_org_group"
  ON "group_role_assignments"("org_id", "principal_group_id");

-- ─── Part 3: Typed per-resource grant tables (replaces generic resource_grants) ─
-- resource_grants uses varchar for every field and has no FK constraints.
-- The typed tables carry proper FK constraints and projected column sets.
-- resource_grants is NOT dropped here: kb_access.service.ts still uses it for
-- kb:space grants. Add kb_space_grants and drop resource_grants in a future pass.

CREATE TABLE IF NOT EXISTS "pm_project_grants" (
  "id"             uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  "org_id"         text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "project_id"     integer NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "principal_type" text NOT NULL DEFAULT 'user',
  "principal_id"   text NOT NULL,
  "permission_key" text NOT NULL,
  "granted_by"     text REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at"     timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_pm_project_grants"
  ON "pm_project_grants"("org_id", "project_id", "principal_type", "principal_id", "permission_key");
CREATE INDEX IF NOT EXISTS "idx_pm_project_grants_org_project"
  ON "pm_project_grants"("org_id", "project_id");
CREATE INDEX IF NOT EXISTS "idx_pm_project_grants_principal"
  ON "pm_project_grants"("org_id", "principal_type", "principal_id");

CREATE TABLE IF NOT EXISTS "pm_workspace_grants" (
  "id"               uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  "org_id"           text NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "pm_workspace_id"  text NOT NULL REFERENCES "pm_workspaces"("pm_workspace_id") ON DELETE CASCADE,
  "principal_type"   text NOT NULL DEFAULT 'user',
  "principal_id"     text NOT NULL,
  "permission_key"   text NOT NULL,
  "granted_by"       text REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at"       timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_pm_workspace_grants"
  ON "pm_workspace_grants"("org_id", "pm_workspace_id", "principal_type", "principal_id", "permission_key");
CREATE INDEX IF NOT EXISTS "idx_pm_workspace_grants_org_workspace"
  ON "pm_workspace_grants"("org_id", "pm_workspace_id");
CREATE INDEX IF NOT EXISTS "idx_pm_workspace_grants_principal"
  ON "pm_workspace_grants"("org_id", "principal_type", "principal_id");
