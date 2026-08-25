-- Custom SQL migration file, put your code below! --

-- The key that opens the legacy-mirror divergence report.
--
-- Party became canonical in this ticket and `leads`, `clients` and `contacts`
-- became a mirror of it. `GET /party/mirror/divergence` is how anyone finds out
-- whether that is still true; a claim nobody can check is a claim that decays.
--
-- Targets `CRM_MODULE_OWNER`, `CRM_MODULE_ADMIN` and `CRM_MODULE_MEMBER`, which
-- is what `seedSystemRolesForOrg` actually mints -- see 0226 for the seven
-- migrations that named `CRM_ADMIN` instead and therefore granted to nobody.
-- `party:` is one of the namespaces the CRM module administers, so these are the
-- roles that already hold every other party key.
--
-- Members are included deliberately. `buildModuleMemberPermissionKeys` gives a
-- newly seeded organisation every key in the namespace ending `:view`, so
-- omitting members here would make an existing tenant behave differently from a
-- new one -- the exact drift 0226 exists to stop. Nothing is disclosed by it
-- that `crm:leads:view` and `party:parties:view` do not already disclose; the
-- report names fields of records the holder can already read.
--
-- Catalog row first, for the reason recorded in 0212: PermissionCatalogSync runs
-- at boot, after db:migrate, so the EXISTS guard is otherwise false here.
--
-- Authored via `generate --custom`; see 0205 for why db:generate cannot run here.

SET lock_timeout = '5s';

--> statement-breakpoint
INSERT INTO "permissions" ("name", "resource", "action", "description", "module_key")
VALUES
  ('party:divergence:view', 'party:divergence', 'view',
   'See which legacy CRM rows disagree with the party they mirror', 'crm')
ON CONFLICT ("name") DO NOTHING;

--> statement-breakpoint
INSERT INTO "role_permission_grants" ("org_id", "role_id", "permission_key", "scope")
SELECT r."org_id", r."id", 'party:divergence:view', 'all'
FROM "roles" r
WHERE r."is_system" = true
  AND r."slug" IN ('CRM_MODULE_OWNER', 'CRM_MODULE_ADMIN', 'CRM_MODULE_MEMBER')
  AND EXISTS (SELECT 1 FROM "permissions" p WHERE p."name" = 'party:divergence:view')
ON CONFLICT DO NOTHING;

--> statement-breakpoint
INSERT INTO "access_versions" ("org_id", "permissions_version", "updated_at")
SELECT DISTINCT r."org_id", 2, now()
FROM "roles" r
WHERE r."is_system" = true AND r."slug" LIKE 'CRM_MODULE_%'
ON CONFLICT ("org_id") DO UPDATE
SET "permissions_version" = "access_versions"."permissions_version" + 1,
    "updated_at" = now();
