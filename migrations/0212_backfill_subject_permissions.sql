-- Custom SQL migration file, put your code below! --

-- Three new subject keys reach the CRM role template through
-- `moduleScopedPermissions("crm")`, which grants only on role CREATION -- so
-- without this they are inert for every organisation that already exists.
-- Same shape as 0207 and 0210, with one addition.
--
-- 0207 and 0210 guard their grant on the key already existing in `permissions`,
-- because `role_permission_grants.permission_key` carries a foreign key to it.
-- That table is populated by PermissionCatalogSyncService at application boot,
-- which happens AFTER db:migrate in a deploy -- so the guard is false at the
-- moment the migration runs and the backfill inserts nothing. Seeding the three
-- rows here first makes the grant land; the boot sync then upserts them onto the
-- same values and does nothing.

SET lock_timeout = '5s';

--> statement-breakpoint
INSERT INTO "permissions" ("name", "resource", "action", "description", "module_key")
VALUES
  ('party:subjects:view', 'party:subjects', 'view',
   'View the things the business transacts, and their declared types', 'party'),
  ('party:subjects:manage', 'party:subjects', 'manage',
   'Create, update and delete subjects, and link them to parties', 'party'),
  ('party:subject-types:manage', 'party:subject-types', 'manage',
   'Declare and change the subject types the organisation transacts', 'party')
ON CONFLICT ("name") DO NOTHING;

--> statement-breakpoint
INSERT INTO "role_permission_grants" ("org_id", "role_id", "permission_key", "scope")
SELECT r."org_id", r."id", k."permission_key", 'all'
FROM "roles" r
CROSS JOIN (
  VALUES
    ('party:subjects:view'),
    ('party:subjects:manage'),
    ('party:subject-types:manage')
) AS k("permission_key")
WHERE r."is_system" = true
  AND r."slug" = 'CRM_ADMIN'
  AND EXISTS (SELECT 1 FROM "permissions" p WHERE p."name" = k."permission_key")
ON CONFLICT DO NOTHING;

--> statement-breakpoint
-- Resolution is cached per (userId, orgId) and busted by this version, so without
-- the bump the new grants stay invisible until the cache happens to expire.
INSERT INTO "access_versions" ("org_id", "permissions_version", "updated_at")
SELECT DISTINCT r."org_id", 2, now()
FROM "roles" r
WHERE r."is_system" = true AND r."slug" = 'CRM_ADMIN'
ON CONFLICT ("org_id") DO UPDATE
SET "permissions_version" = "access_versions"."permissions_version" + 1,
    "updated_at" = now();
