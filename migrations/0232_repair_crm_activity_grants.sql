-- The two keys `0226` missed.
--
-- `0226` set out to repair seven backfills that had granted CRM permissions to
-- role slug `CRM_ADMIN` — a `ROLE_TEMPLATES` slug the seeder never mints, so
-- every grant landed on nobody. It repaired sixteen keys. The damage was
-- eighteen.
--
-- `0216_backfill_activity_permissions.sql` is the one that slipped through:
-- it names `CRM_ADMIN` like the rest, but `crm:activities:view` and
-- `crm:activities:manage` are absent from `0226`'s VALUES lists. The
-- "sixteen permissions" in that migration's header is the length of its own
-- list, not a count of the damage — which is how a repair migration came to
-- assert its own completeness without anything checking it.
--
-- What this costs: every endpoint in `activities.controller.ts` carries
-- `@RequirePermission("crm:activities:view" | ":manage")`. So the unified
-- timeline — the feature the whole branch is built around — returns 403 for
-- every user in every organisation seeded before this branch, `CRM_MODULE_OWNER`
-- included. Confirmed against the database: zero grants exist for either key,
-- while `crm:autonomy:view` (which `0226` did repair) reaches all three roles
-- across every organisation.
--
-- A newly created organisation is unaffected: both keys are in `CRM_PERMISSIONS`,
-- so `buildModuleAdminPermissionKeys("crm")` hands them out at seed time. Only
-- existing tenants need this, and `seedSystemRolesForOrg` cannot help them —
-- it grants solely on role *creation* (`if (inserted.length > 0)`), so re-seeding
-- an organisation that already has its roles adds nothing.

INSERT INTO "role_permission_grants" ("org_id", "role_id", "permission_key", "scope")
SELECT r."org_id", r."id", k."permission_key", 'all'
FROM "roles" r
CROSS JOIN (VALUES
  ('crm:activities:view'), ('crm:activities:manage')
) AS k("permission_key")
WHERE r."is_system" = true
  AND r."slug" IN ('CRM_MODULE_OWNER', 'CRM_MODULE_ADMIN')
  AND EXISTS (SELECT 1 FROM "permissions" p WHERE p."name" = k."permission_key")
ON CONFLICT DO NOTHING;

--> statement-breakpoint
-- `crm:activities:view` ends in `:view`, so `buildModuleMemberPermissionKeys`
-- gives it to `CRM_MODULE_MEMBER` in a freshly seeded organisation. Granting it
-- here too is not generosity — it is the same invariant `0226` states and then
-- breaks: a backfilled organisation and a newly seeded one must resolve to the
-- same capability, or a tenant's permissions depend on when they signed up.
INSERT INTO "role_permission_grants" ("org_id", "role_id", "permission_key", "scope")
SELECT r."org_id", r."id", 'crm:activities:view', 'all'
FROM "roles" r
WHERE r."is_system" = true
  AND r."slug" = 'CRM_MODULE_MEMBER'
  AND EXISTS (SELECT 1 FROM "permissions" p WHERE p."name" = 'crm:activities:view')
ON CONFLICT DO NOTHING;

--> statement-breakpoint
INSERT INTO "access_versions" ("org_id", "permissions_version", "updated_at")
SELECT DISTINCT r."org_id", 2, now()
FROM "roles" r
WHERE r."is_system" = true AND r."slug" LIKE 'CRM_MODULE_%'
ON CONFLICT ("org_id") DO UPDATE
SET "permissions_version" = "access_versions"."permissions_version" + 1,
    "updated_at" = now();
