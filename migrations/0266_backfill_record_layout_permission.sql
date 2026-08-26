-- Custom SQL migration file, put your code below! --

-- `settings:record-layouts:manage`, seeded and granted.
--
-- Templates grant on role CREATION only, so a key added to a template is inert
-- for every organisation that already exists. Catalog rows go first: the grant
-- carries a foreign key to `permissions.name`, and PermissionCatalogSyncService
-- runs at application boot -- after db:migrate -- so the guard would otherwise be
-- false when this runs and the backfill would insert nothing.

SET lock_timeout = '5s';

--> statement-breakpoint
INSERT INTO "permissions" ("name", "resource", "action", "description", "module_key")
VALUES (
  'settings:record-layouts:manage',
  'settings:record-layouts',
  'manage',
  'Reorder, hide and group the fields of a record type for this organisation',
  'settings'
)
ON CONFLICT ("name") DO NOTHING;

--> statement-breakpoint
-- The roles that already administer the organisation's settings. Rearranging a
-- record type is the same class of act as managing its custom fields, so it
-- lands with whoever already holds that.
INSERT INTO "role_permission_grants" ("org_id", "role_id", "permission_key", "scope")
SELECT DISTINCT g."org_id", g."role_id", 'settings:record-layouts:manage', 'all'
FROM "role_permission_grants" g
WHERE g."permission_key" = 'settings:custom-fields:manage'
ON CONFLICT DO NOTHING;

--> statement-breakpoint
-- Resolution is cached per (userId, orgId) and busted by this version, so
-- without the bump the new grant stays invisible until the cache happens to
-- expire.
INSERT INTO "access_versions" ("org_id", "permissions_version", "updated_at")
SELECT DISTINCT g."org_id", 2, now()
FROM "role_permission_grants" g
WHERE g."permission_key" = 'settings:record-layouts:manage'
ON CONFLICT ("org_id") DO UPDATE
SET "permissions_version" = "access_versions"."permissions_version" + 1,
    "updated_at" = now();
