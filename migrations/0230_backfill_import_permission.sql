-- Custom SQL migration file, put your code below! --

-- The import key, seeded and backfilled onto the CRM roles.
--
-- Targets `CRM_MODULE_OWNER` and `CRM_MODULE_ADMIN`, which is what
-- `seedSystemRolesForOrg` actually mints -- see 0226 for the seven migrations
-- that targeted `CRM_ADMIN` instead and therefore granted to nobody at all.
--
-- Deliberately NOT granted to `CRM_MODULE_MEMBER`: members receive keys ending
-- `:view` or `:read`, and importing writes to every record in the organisation.
--
-- Catalog rows first, for the reason recorded in 0212: PermissionCatalogSync
-- runs at boot, after db:migrate, so the EXISTS guard is otherwise false here.
--
-- Authored via `generate --custom`; see 0205 for why db:generate cannot run here.

SET lock_timeout = '5s';

--> statement-breakpoint
INSERT INTO "permissions" ("name", "resource", "action", "description", "module_key")
VALUES
  ('crm:imports:manage', 'crm:imports', 'manage',
   'Bring a CRM export into StreamlineOS, and take an import back out', 'crm')
ON CONFLICT ("name") DO NOTHING;

--> statement-breakpoint
INSERT INTO "role_permission_grants" ("org_id", "role_id", "permission_key", "scope")
SELECT r."org_id", r."id", 'crm:imports:manage', 'all'
FROM "roles" r
WHERE r."is_system" = true
  AND r."slug" IN ('CRM_MODULE_OWNER', 'CRM_MODULE_ADMIN')
  AND EXISTS (SELECT 1 FROM "permissions" p WHERE p."name" = 'crm:imports:manage')
ON CONFLICT DO NOTHING;

--> statement-breakpoint
INSERT INTO "access_versions" ("org_id", "permissions_version", "updated_at")
SELECT DISTINCT r."org_id", 2, now()
FROM "roles" r
WHERE r."is_system" = true AND r."slug" LIKE 'CRM_MODULE_%'
ON CONFLICT ("org_id") DO UPDATE
SET "permissions_version" = "access_versions"."permissions_version" + 1,
    "updated_at" = now();
