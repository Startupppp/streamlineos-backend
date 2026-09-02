-- P0: no organisation can be created at head.
--
-- Commit 600b9b7c registered feedbucket in MODULE_REGISTRY as
-- planGated: true, ladder: "delegable". That puts it in MODULE_CATALOG and
-- ACCESS_MANAGED_MODULES, hence in MODULE_ADMIN_MODULES, so
-- seedSystemRolesForOrg mints FEEDBUCKET_MODULE_ADMIN with
-- roles.module_key = 'feedbucket'. Migration 0634 gave roles.module_key a
-- foreign key to modules_catalog.module_key, and NOT VALID skips existing rows,
-- not new inserts. No migration ever inserted the catalog row, so the seeder
-- raises:
--
--   insert or update on table "roles" violates foreign key constraint
--   "fk_roles_module"
--   Key (module_key)=(feedbucket) is not present in table "modules_catalog".
--
-- OrgProfileService.createOrganization calls the seeder INSIDE the creation
-- transaction (org-profile.service.ts:366), so the failure is total: the
-- organisation is never created at all.
--
-- The statement is ticket 19's, unchanged. Checked against the live catalog on a
-- scratch database at head: the seven columns match information_schema exactly,
-- sort_order 13 is free (timesheets holds 12, notifications jumps to 90), and
-- is_paid_only is false because that column marks the two paid-only modules
-- (inventory, payroll) and not plan-gating -- support and surveys are both
-- planGated: true and both sit at is_paid_only = false. is_core is false because
-- feedbucket is not one of the nine platform-core modules.
--
-- Held green from here by src/modules/rbac/__tests__/seeded-role-modules-are-
-- catalogued.spec.ts, which reads every INSERT INTO modules_catalog out of this
-- directory and fails on any MODULE_ADMIN_MODULES entry with no row. It was
-- deliberately red on exactly this offender.

SET lock_timeout = '5s';
--> statement-breakpoint

INSERT INTO "modules_catalog"
  ("module_key", "name", "description", "is_core", "is_paid_only", "sort_order", "status")
VALUES ('feedbucket', 'Feedbucket', 'Embeddable feedback widget and its submissions',
        false, false, 13, 'ACTIVE')
ON CONFLICT ("module_key") DO NOTHING;
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM modules_catalog WHERE module_key = 'feedbucket') THEN
    RAISE EXCEPTION 'feedbucket is still missing from modules_catalog';
  END IF;
END $$;
