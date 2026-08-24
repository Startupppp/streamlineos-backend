-- Custom SQL migration file, put your code below! --

-- The three autonomy-review keys, seeded and backfilled onto the CRM role.
--
-- `CRM_ADMIN` is defined as `moduleScopedPermissions("crm")`, so these keys join
-- the template automatically -- but `seedSystemRolesForOrg` grants on role
-- *creation*, and a re-seed deliberately never touches an existing role's
-- grants, so a template change alone reaches new organisations only. Without
-- this backfill the review feed is a screen that every existing tenant's CRM
-- administrator is refused.
--
-- Catalog rows first, for the reason recorded in 0212: PermissionCatalogSync
-- runs at application boot, after db:migrate, so the EXISTS guard below is
-- otherwise false when this runs and the grant inserts nothing.
--
-- Authored via `generate --custom`; see 0205 for why db:generate cannot run here.

SET lock_timeout = '5s';

--> statement-breakpoint
INSERT INTO "permissions" ("name", "resource", "action", "description", "module_key")
VALUES
  ('crm:autonomy:review', 'crm:autonomy', 'review',
   'Review what the CRM decided and did on its own', 'crm'),
  ('crm:autonomy:reverse', 'crm:autonomy', 'reverse',
   'Reverse an autonomous CRM action', 'crm'),
  ('crm:autonomy:configure', 'crm:autonomy', 'configure',
   'Turn autonomous CRM action types on or off for the organisation', 'crm')
ON CONFLICT ("name") DO NOTHING;

--> statement-breakpoint
INSERT INTO "role_permission_grants" ("org_id", "role_id", "permission_key", "scope")
SELECT r."org_id", r."id", k."permission_key", 'all'
FROM "roles" r
CROSS JOIN (VALUES
  ('crm:autonomy:review'),
  ('crm:autonomy:reverse'),
  ('crm:autonomy:configure')
) AS k("permission_key")
WHERE r."is_system" = true
  AND r."slug" = 'CRM_ADMIN'
  AND EXISTS (SELECT 1 FROM "permissions" p WHERE p."name" = k."permission_key")
ON CONFLICT DO NOTHING;

--> statement-breakpoint
-- Every permission mutation bumps the access version, or a resolved set cached
-- against the old one keeps 403-ing until something unrelated changes.
INSERT INTO "access_versions" ("org_id", "permissions_version", "updated_at")
SELECT DISTINCT r."org_id", 2, now()
FROM "roles" r
WHERE r."is_system" = true AND r."slug" = 'CRM_ADMIN'
ON CONFLICT ("org_id") DO UPDATE
SET "permissions_version" = "access_versions"."permissions_version" + 1,
    "updated_at" = now();
