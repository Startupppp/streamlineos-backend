-- Custom SQL migration file, put your code below! --

-- Repairs 0207 and 0210, which granted nothing.
--
-- Both guard their INSERT on `EXISTS (SELECT 1 FROM permissions ...)`, because
-- role_permission_grants.permission_key carries a foreign key to permissions.name
-- and an unguarded grant would abort the migration. But `permissions` is populated
-- by PermissionCatalogSyncService, an OnModuleInit that runs when the application
-- boots -- which in a deploy is AFTER db:migrate. At the moment 0207 and 0210 ran,
-- their keys did not exist, the guard was false, and the SELECT returned no rows.
-- Nothing failed and nothing was granted.
--
-- 0212 found this and seeds the rows before granting. This does the same for the
-- nine keys the two earlier migrations were supposed to place on CRM_ADMIN. The
-- boot sync then upserts the same rows onto the same values and does nothing.
--
-- Idempotent, so re-running after a partial repair is safe.

SET lock_timeout = '5s';

--> statement-breakpoint
INSERT INTO "permissions" ("name", "resource", "action", "description", "module_key")
VALUES
  ('party:parties:view', 'party:parties', 'view',
   'View business parties (customers, vendors, partners)', 'party'),
  ('party:parties:create', 'party:parties', 'create',
   'Create business parties', 'party'),
  ('party:parties:update', 'party:parties', 'update',
   'Update business parties', 'party'),
  ('party:parties:delete', 'party:parties', 'delete',
   'Soft-delete business parties', 'party'),
  ('party:contacts:view', 'party:contacts', 'view',
   'View contacts linked to a business party', 'party'),
  ('party:contacts:manage', 'party:contacts', 'manage',
   'Create, update, and delete contacts for a business party', 'party'),
  ('party:roles:manage', 'party:roles', 'manage',
   'Assign and remove the roles a party holds', 'party'),
  ('party:duplicates:view', 'party:duplicates', 'view',
   'See parties the system believes may be the same organisation', 'party'),
  ('party:merges:manage', 'party:merges', 'manage',
   'Merge two parties, and reverse a merge', 'party')
ON CONFLICT ("name") DO NOTHING;

--> statement-breakpoint
INSERT INTO "role_permission_grants" ("org_id", "role_id", "permission_key", "scope")
SELECT r."org_id", r."id", k."permission_key", 'all'
FROM "roles" r
CROSS JOIN (
  VALUES
    ('party:parties:view'),
    ('party:parties:create'),
    ('party:parties:update'),
    ('party:parties:delete'),
    ('party:contacts:view'),
    ('party:contacts:manage'),
    ('party:roles:manage'),
    ('party:duplicates:view'),
    ('party:merges:manage')
) AS k("permission_key")
WHERE r."is_system" = true
  AND r."slug" = 'CRM_ADMIN'
ON CONFLICT DO NOTHING;

--> statement-breakpoint
-- Resolution is cached per (userId, orgId) and busted by this version, so without
-- the bump the repaired grants stay invisible until the cache happens to expire.
INSERT INTO "access_versions" ("org_id", "permissions_version", "updated_at")
SELECT DISTINCT r."org_id", 2, now()
FROM "roles" r
WHERE r."is_system" = true AND r."slug" = 'CRM_ADMIN'
ON CONFLICT ("org_id") DO UPDATE
SET "permissions_version" = "access_versions"."permissions_version" + 1,
    "updated_at" = now();
