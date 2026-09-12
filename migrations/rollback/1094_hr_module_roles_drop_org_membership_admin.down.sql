-- Reverses 1094 for the rung it was aimed at: HR_MODULE_ADMIN and HR_MODULE_OWNER get
-- `settings:organization:manage` back at scope `all`, which is the state
-- `MODULE_ADMIN_EXTRA_KEYS.hr` produced before the template was repaired. Restoring it here means
-- reinstating the escalation; that is what a rollback of 1094 is.
--
-- The EXISTS guard is not decoration: `role_permission_grants.permission_key` carries a foreign key
-- to `permissions.name`, and that catalog is filled by `PermissionCatalogSyncService` at boot,
-- after the migration runner. Without the guard this rollback fails 23503 on a cold database.
--
-- What it CANNOT restore: the `user_permission_grants` and `user_delegation_permissions` rows 1094
-- removed. Nothing records which membership or which delegation held them, so re-issuing them would
-- be invention, not reversal. A delegation is re-created through POST /delegations and a per-person
-- grant through PUT /module-access/:moduleKey/members/:membershipId/grants.
SET lock_timeout = '5s';
--> statement-breakpoint
WITH restored_role_grants AS (
  INSERT INTO "role_permission_grants" ("org_id", "role_id", "permission_key", "scope")
  SELECT r."org_id", r."id", 'settings:organization:manage', 'all'
  FROM "roles" AS r
  WHERE r."slug" IN ('HR_MODULE_ADMIN', 'HR_MODULE_OWNER')
    AND EXISTS (
      SELECT 1 FROM "permissions" AS p
      WHERE p."name" = 'settings:organization:manage'
    )
  ON CONFLICT DO NOTHING
  RETURNING "org_id" AS org_id
)
INSERT INTO "access_versions" ("org_id", "permissions_version", "updated_at")
SELECT DISTINCT org_id, 2, now()
FROM restored_role_grants
ON CONFLICT ("org_id") DO UPDATE
SET "permissions_version" = "access_versions"."permissions_version" + 1,
    "updated_at" = now();
