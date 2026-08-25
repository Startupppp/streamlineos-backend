-- Custom SQL migration file, put your code below! --

-- Two new activity keys reach the CRM role template through
-- `moduleScopedPermissions("crm")`, which grants only on role CREATION, so
-- without this they are inert for every organisation that already exists.
--
-- The catalog rows are seeded first for the reason recorded in 0212: the guard
-- below is false at migrate time otherwise, because
-- PermissionCatalogSyncService runs at application boot, after db:migrate.

SET lock_timeout = '5s';

--> statement-breakpoint
INSERT INTO "permissions" ("name", "resource", "action", "description", "module_key")
VALUES
  ('crm:activities:view', 'crm:activities', 'view',
   'Read the unified timeline of calls, emails, meetings, notes and tasks', 'crm'),
  ('crm:activities:manage', 'crm:activities', 'manage',
   'Log, edit, complete and remove activities on the timeline', 'crm')
ON CONFLICT ("name") DO NOTHING;

--> statement-breakpoint
INSERT INTO "role_permission_grants" ("org_id", "role_id", "permission_key", "scope")
SELECT r."org_id", r."id", k."permission_key", 'all'
FROM "roles" r
CROSS JOIN (
  VALUES ('crm:activities:view'), ('crm:activities:manage')
) AS k("permission_key")
WHERE r."is_system" = true
  AND r."slug" = 'CRM_ADMIN'
  AND EXISTS (SELECT 1 FROM "permissions" p WHERE p."name" = k."permission_key")
ON CONFLICT DO NOTHING;

--> statement-breakpoint
INSERT INTO "access_versions" ("org_id", "permissions_version", "updated_at")
SELECT DISTINCT r."org_id", 2, now()
FROM "roles" r
WHERE r."is_system" = true AND r."slug" = 'CRM_ADMIN'
ON CONFLICT ("org_id") DO UPDATE
SET "permissions_version" = "access_versions"."permissions_version" + 1,
    "updated_at" = now();
