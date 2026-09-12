-- Custom SQL migration file, put your code below! --

-- Phase 5 ticket 07's keys. `GET /crm/lifecycles`, `GET /crm/lifecycles/:id`,
-- and the three write routes under it become reachable.
--
-- Two keys, not one. Reading who is up for renewal and how exposed the revenue
-- is belongs to anybody planning a quarter; filing a signal moves the score that
-- decides whose renewal gets attention this week, and recording a renewal or a
-- churn changes what the company believes its recurring revenue to be. Folding
-- them together would make the second unavoidable to grant with the first.
--
-- The slugs are `CRM_MODULE_OWNER|ADMIN|MEMBER`, which is what
-- `seedSystemRolesForOrg` actually mints -- NOT `CRM_ADMIN`, which is a
-- `ROLE_TEMPLATES` entry an administrator may manually create a role from and
-- which no organisation has. Seven migrations in the CRM series made exactly
-- that mistake, granted eighteen permissions to nobody, and reported success:
-- `ON CONFLICT DO NOTHING` over an empty result set is a clean migration. See
-- 0226, and `backfill-slugs-exist.spec.ts`, which now fails the build for it.
--
-- The member split mirrors `buildModuleMemberPermissionKeys`, which filters the
-- module's namespace to keys ending `:view` or `:read`. Kept identical on
-- purpose: a backfilled organisation and a freshly seeded one must resolve to
-- the same capability, or behaviour depends on when the tenant signed up.
--
-- `ORG_ADMIN` is granted both as well. `ROLE_DEFAULT_PERMISSIONS.ORG_ADMIN` is
-- `ALL_PERMISSION_NAMES`, so an organisation created after this ships gets both
-- keys at seed time; this closes the same gap for the ones created before. No
-- `OWNER` grant, and not because it was forgotten: `access.service.ts` answers
-- scope 'all' for `isOrgOwner` before any grant is consulted, so an organisation
-- owner already holds every catalogued key without a row.

SET lock_timeout = '5s';

--> statement-breakpoint
INSERT INTO "permissions" ("name", "resource", "action", "description", "module_key")
VALUES
  ('crm:lifecycle:view', 'crm:lifecycle', 'view',
   'Read the renewal book: which customer contracts come up when, what they are worth, and the signals behind each risk score',
   'crm'),
  ('crm:lifecycle:manage', 'crm:lifecycle', 'manage',
   'File a lifecycle signal, renew a customer contract into its next term, or close it as churned or cancelled',
   'crm')
ON CONFLICT ("name") DO NOTHING;

--> statement-breakpoint
-- Owners and admins receive the module's whole namespace, which is what
-- `buildModuleAdminPermissionKeys` gives a newly seeded organisation.
INSERT INTO "role_permission_grants" ("org_id", "role_id", "permission_key", "scope")
SELECT r."org_id", r."id", k."permission_key", 'all'
FROM "roles" r
CROSS JOIN (VALUES
  ('crm:lifecycle:view'),
  ('crm:lifecycle:manage')
) AS k("permission_key")
WHERE r."is_system" = true
  AND r."slug" IN ('CRM_MODULE_OWNER', 'CRM_MODULE_ADMIN', 'ORG_ADMIN')
  AND EXISTS (SELECT 1 FROM "permissions" p WHERE p."name" = k."permission_key")
ON CONFLICT DO NOTHING;

--> statement-breakpoint
-- Members receive the read key only. A rep should see their customers' renewal
-- dates; deciding that a customer churned is not their call.
INSERT INTO "role_permission_grants" ("org_id", "role_id", "permission_key", "scope")
SELECT r."org_id", r."id", 'crm:lifecycle:view', 'all'
FROM "roles" r
WHERE r."is_system" = true
  AND r."slug" = 'CRM_MODULE_MEMBER'
  AND EXISTS (SELECT 1 FROM "permissions" p WHERE p."name" = 'crm:lifecycle:view')
ON CONFLICT DO NOTHING;

--> statement-breakpoint
-- Bump so cached permission resolutions are invalidated across every node at
-- once; a role that gained a key and a cache that has not heard about it is a
-- 403 nobody can reproduce.
INSERT INTO "access_versions" ("org_id", "permissions_version", "updated_at")
SELECT DISTINCT r."org_id", 2, now()
FROM "roles" r
WHERE r."is_system" = true
  AND (r."slug" LIKE 'CRM_MODULE_%' OR r."slug" = 'ORG_ADMIN')
ON CONFLICT ("org_id") DO UPDATE
SET "permissions_version" = "access_versions"."permissions_version" + 1,
    "updated_at" = now();
