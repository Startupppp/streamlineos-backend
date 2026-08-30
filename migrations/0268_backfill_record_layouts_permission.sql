-- Ticket 20's key, seeded into the catalogue and backfilled onto the roles that
-- a newly created organisation would receive it on.
--
-- `settings:record-layouts:manage` gates PUT, DELETE and the usage sample on
-- `/renderer/layouts/:layoutKey`. Reading an arrangement is deliberately
-- ungated — every user has to read their tenant's to render anything — so this
-- key buys exactly one thing: changing it.
--
-- Catalogue row FIRST, for the reason 0212 and 0230 both record:
-- `PermissionCatalogSync` runs at boot, which is AFTER `db:migrate`, so the
-- EXISTS guard below is false at the moment this migration runs unless the row
-- is inserted here. A backfill that silently matches nothing is a clean
-- migration and a dead permission.
--
-- WHICH SLUGS, and why these three:
--
--   `ORG_ADMIN` — `buildOrgAdminPermissionKeys` hands an organisation admin
--   every `settings:` key, so a NEW organisation gets this one automatically.
--   Omitting it here would make a tenant's capability depend on their signup
--   date, which is the divergence 0226 exists to prevent.
--
--   `CRM_MODULE_OWNER` / `CRM_MODULE_ADMIN` — every record type this key can
--   arrange is a CRM or Party one. `MODULE_ADMIN_EXTRA_KEYS.crm` now names the
--   key, so `buildModuleAdminPermissionKeys("crm")` grants it at seed time; this
--   is the same grant for organisations that already exist.
--
-- Deliberately NOT `CRM_MODULE_MEMBER`: members receive keys ending `:view` or
-- `:read`, and rearranging a record type changes the screen for every colleague
-- in the organisation, not for the person who did it.
--
-- Deliberately NOT `SETTINGS_ADMIN` or any other `ROLE_TEMPLATES` slug.
-- `seedSystemRolesForOrg` mints `${MODULE}_MODULE_OWNER|ADMIN|MEMBER` plus
-- `ORG_ADMIN` and `MEMBER`, and nothing else; seven migrations in this series
-- granted to `CRM_ADMIN` — a template, not a seeded role — and reached nobody at
-- all. See 0226, 0230, 0232 and `backfill-slugs-exist.spec.ts`.
--
-- The organisation OWNER needs no grant: `AccessService.scopeFor` returns "all"
-- for `isOrgOwner` before any lookup, and the seeder mints no OWNER role.

SET lock_timeout = '5s';

--> statement-breakpoint
INSERT INTO "permissions" ("name", "resource", "action", "description", "module_key")
VALUES
  ('settings:record-layouts:manage', 'settings:record-layouts', 'manage',
   'Arrange which fields a record type shows, in what order, and under which headings',
   'settings')
ON CONFLICT ("name") DO NOTHING;

--> statement-breakpoint
INSERT INTO "role_permission_grants" ("org_id", "role_id", "permission_key", "scope")
SELECT r."org_id", r."id", 'settings:record-layouts:manage', 'all'
FROM "roles" r
WHERE r."is_system" = true
  AND r."slug" IN ('ORG_ADMIN', 'CRM_MODULE_OWNER', 'CRM_MODULE_ADMIN')
  AND EXISTS (
    SELECT 1 FROM "permissions" p WHERE p."name" = 'settings:record-layouts:manage'
  )
ON CONFLICT DO NOTHING;

--> statement-breakpoint
-- Resolved permissions are cached per organisation and keyed on this version.
-- Without the bump the grants above are invisible until the cache expires.
INSERT INTO "access_versions" ("org_id", "permissions_version", "updated_at")
SELECT DISTINCT r."org_id", 2, now()
FROM "roles" r
WHERE r."is_system" = true
  AND r."slug" IN ('ORG_ADMIN', 'CRM_MODULE_OWNER', 'CRM_MODULE_ADMIN')
ON CONFLICT ("org_id") DO UPDATE
SET "permissions_version" = "access_versions"."permissions_version" + 1,
    "updated_at" = now();
