-- The data-quality queue's keys, seeded and backfilled onto the CRM roles.
--
-- Targets `CRM_MODULE_OWNER`, `CRM_MODULE_ADMIN` and `CRM_MODULE_MEMBER`, which
-- is what `seedSystemRolesForOrg` actually mints. It does NOT target `CRM_ADMIN`
-- -- that is a `ROLE_TEMPLATES` slug an administrator may manually create a role
-- from, and the seven migrations that named it granted eighteen permissions to
-- nobody at all, silently, because `ON CONFLICT DO NOTHING` over an empty result
-- set is a clean migration. See 0226 and 0232, and
-- `rbac/__tests__/backfill-slugs-exist.spec.ts`, which now fails the build if
-- anyone repeats it.
--
-- Three keys, one of them a repair:
--
-- `crm:data-quality:view` is NOT new -- it has been in `CRM_PERMISSIONS` since
-- before this branch and is gated on `GET /crm/data-quality`, the standing
-- report. No migration ever backfilled it, so `buildModuleAdminPermissionKeys`
-- hands it to newly seeded organisations and every organisation that already
-- existed has it granted to nobody. It is repaired here rather than left,
-- because the queue this migration creates is unreachable for those tenants
-- otherwise -- exactly the failure 0232 documents.
--
-- `crm:data-quality:assign` and `crm:data-quality:resolve` are new.
--
-- Member gets `:view` and nothing else, matching
-- `buildModuleMemberPermissionKeys`, which grants keys ending `:view` or
-- `:read`. That agreement is the invariant: a backfilled organisation and a
-- newly seeded one must resolve to the same capability, or a tenant's
-- permissions depend on when they signed up.
--
-- Catalog rows first, for the reason recorded in 0212: `PermissionCatalogSync`
-- runs at boot, after `db:migrate`, so the EXISTS guard below is otherwise false
-- and every grant is skipped.
--
-- Authored via `generate --custom`; see 0205 for why db:generate cannot run here.

SET lock_timeout = '5s';

--> statement-breakpoint
INSERT INTO "permissions" ("name", "resource", "action", "description", "module_key")
VALUES
  ('crm:data-quality:view', 'crm:data-quality', 'view',
   'View CRM data quality dashboard', 'crm'),
  ('crm:data-quality:assign', 'crm:data-quality', 'assign',
   'Assign data quality findings to a person, or hand them back to the queue', 'crm'),
  ('crm:data-quality:resolve', 'crm:data-quality', 'resolve',
   'Resolve or dismiss data quality findings in bulk, reverse a resolution, and run the producers', 'crm')
ON CONFLICT ("name") DO NOTHING;

--> statement-breakpoint
INSERT INTO "role_permission_grants" ("org_id", "role_id", "permission_key", "scope")
SELECT r."org_id", r."id", k."permission_key", 'all'
FROM "roles" r
CROSS JOIN (VALUES
  ('crm:data-quality:view'),
  ('crm:data-quality:assign'),
  ('crm:data-quality:resolve')
) AS k("permission_key")
WHERE r."is_system" = true
  AND r."slug" IN ('CRM_MODULE_OWNER', 'CRM_MODULE_ADMIN')
  AND EXISTS (SELECT 1 FROM "permissions" p WHERE p."name" = k."permission_key")
ON CONFLICT DO NOTHING;

--> statement-breakpoint
INSERT INTO "role_permission_grants" ("org_id", "role_id", "permission_key", "scope")
SELECT r."org_id", r."id", 'crm:data-quality:view', 'all'
FROM "roles" r
WHERE r."is_system" = true
  AND r."slug" = 'CRM_MODULE_MEMBER'
  AND EXISTS (SELECT 1 FROM "permissions" p WHERE p."name" = 'crm:data-quality:view')
ON CONFLICT DO NOTHING;

--> statement-breakpoint
INSERT INTO "access_versions" ("org_id", "permissions_version", "updated_at")
SELECT DISTINCT r."org_id", 2, now()
FROM "roles" r
WHERE r."is_system" = true AND r."slug" LIKE 'CRM_MODULE_%'
ON CONFLICT ("org_id") DO UPDATE
SET "permissions_version" = "access_versions"."permissions_version" + 1,
    "updated_at" = now();
