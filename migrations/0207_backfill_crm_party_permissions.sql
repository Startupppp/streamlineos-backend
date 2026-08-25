-- Custom SQL migration file, put your code below! --

-- CRM now owns the `party` permission namespace, so `moduleScopedPermissions("crm")`
-- grants party keys to the CRM role template. Templates only grant on role CREATION
-- --- seed-system-roles.spec.ts asserts a re-seed must not touch an existing role's
-- grants, so an owner's revocation is never silently restored --- which means the
-- change is inert for every organisation that already exists. This backfills it onto
-- the CRM role, and nothing else.

SET lock_timeout = '5s';

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
    ('party:contacts:manage')
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
