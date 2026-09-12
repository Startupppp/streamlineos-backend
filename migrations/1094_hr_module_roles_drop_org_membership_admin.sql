-- `settings:organization:manage` is organisation administration: it is the gate on POST /users,
-- POST /users/invite, POST /users/bulk-invite, the invitation resend/cancel/role routes and the
-- member suspend/reactivate/remove routes in users.controller.ts.
--
-- `MODULE_ADMIN_EXTRA_KEYS.hr` in src/modules/rbac/seed-system-roles.ts listed that key, and
-- `buildModuleAdminPermissionKeys` feeds that list to both HR_MODULE_ADMIN and HR_MODULE_OWNER, so
-- every organisation ever seeded gave an HR *module* administrator *organisation* membership
-- administration. The template entry is removed in the same change as this migration.
-- `RoleGrantReconcilerService` only inserts and never deletes, so removing the entry stops new
-- organisations acquiring the grant and does nothing for the ones that already hold it. This
-- migration is the withdrawal.
--
-- Scoped by role slug, and deliberately NOT by `is_system`: 0436 and 0990 both predicated on
-- `is_system` and matched zero rows. It is also not scoped by `roles.module_key = 'hr'`, which
-- would additionally strike HR_ADMIN, BRANCH_HR and RECRUITER — those templates never carried the
-- key (invitation-admin-permissions.spec.ts asserts their absence), so a row on one of them is an
-- administrator's deliberate grant, not this defect.
--
-- `user_permission_grants` is cleared only for rows attributed to the HR module.
-- `fk_user_permission_grants_permission_module` pins (permission_key, module_key) to
-- (permissions.name, permissions.administering_module_key), and this key's administering module is
-- `settings`, so an HR-attributed row cannot be written today; the statement removes any that
-- predate that constraint. Deleting the key unscoped would also revoke an organisation
-- administrator's own per-person grant, which is not this defect.
--
-- `user_delegation_permissions` has no module column, and `assertDelegationPolicy` calls
-- `assertPermissionsGrantable` WITHOUT `allowedModules`, so the cross-module fence does not apply
-- to a delegation: an HR module admin holding this key could pass it to someone else for up to 90
-- days. Those rows are withdrawn only where the delegator is neither the organisation owner nor an
-- ORG_ADMIN — the only shape this defect can produce. A delegation an owner or org admin created
-- is left alone.
--
-- Resolution is cached per (userId, orgId) behind `access_versions.permissions_version`, so each
-- statement bumps the version of exactly the organisations it took a row from: a revoked key must
-- not survive in a warm cache. Re-running deletes nothing and bumps nothing.
SET lock_timeout = '5s';
--> statement-breakpoint
WITH revoked_role_grants AS (
  DELETE FROM "role_permission_grants" AS g
  USING "roles" AS r
  WHERE r."id" = g."role_id"
    AND r."org_id" = g."org_id"
    AND g."permission_key" = 'settings:organization:manage'
    AND r."slug" IN ('HR_MODULE_ADMIN', 'HR_MODULE_OWNER')
  RETURNING g."org_id" AS org_id
)
INSERT INTO "access_versions" ("org_id", "permissions_version", "updated_at")
SELECT DISTINCT org_id, 2, now()
FROM revoked_role_grants
ON CONFLICT ("org_id") DO UPDATE
SET "permissions_version" = "access_versions"."permissions_version" + 1,
    "updated_at" = now();
--> statement-breakpoint
WITH revoked_person_grants AS (
  DELETE FROM "user_permission_grants"
  WHERE "permission_key" = 'settings:organization:manage'
    AND "module_key" = 'hr'
  RETURNING "org_id" AS org_id
)
INSERT INTO "access_versions" ("org_id", "permissions_version", "updated_at")
SELECT DISTINCT org_id, 2, now()
FROM revoked_person_grants
ON CONFLICT ("org_id") DO UPDATE
SET "permissions_version" = "access_versions"."permissions_version" + 1,
    "updated_at" = now();
--> statement-breakpoint
WITH revoked_delegated_grants AS (
  DELETE FROM "user_delegation_permissions" AS p
  USING "user_delegations" AS d
    JOIN "organization_members" AS m
      ON m."org_id" = d."org_id"
     AND m."id" = d."delegator_membership_id"
  WHERE p."org_id" = d."org_id"
    AND p."delegation_id" = d."id"
    AND p."permission_key" = 'settings:organization:manage'
    AND m."is_owner" = false
    AND m."role" <> 'ORG_ADMIN'
  RETURNING p."org_id" AS org_id
)
INSERT INTO "access_versions" ("org_id", "permissions_version", "updated_at")
SELECT DISTINCT org_id, 2, now()
FROM revoked_delegated_grants
ON CONFLICT ("org_id") DO UPDATE
SET "permissions_version" = "access_versions"."permissions_version" + 1,
    "updated_at" = now();
