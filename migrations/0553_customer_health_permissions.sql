-- Custom SQL migration file, put your code below! --

-- Phase 5 ticket 08's keys. `GET /crm/customer-health`,
-- `GET /crm/customer-health/:partyId` and
-- `POST /crm/customer-health/:partyId/recompute` become reachable.
--
-- Two keys, not one. Reading which customers look unhealthy -- and the four
-- inputs each score decomposes into -- is a planning question anybody running a
-- book asks. Recomputing WRITES: it replaces the assessment, replaces its factor
-- rows, and overwrites `business_parties.health_score`, which a dozen other
-- screens render. Folding them together would make the second unavoidable to
-- grant with the first.
--
-- The slugs are `CRM_MODULE_OWNER|ADMIN|MEMBER`, which is what
-- `seedSystemRolesForOrg` actually mints -- NOT `CRM_ADMIN`, which is a
-- `ROLE_TEMPLATES` entry no organisation has. Seven migrations in the CRM series
-- made exactly that mistake, granted eighteen permissions to nobody, and
-- reported success: `ON CONFLICT DO NOTHING` over an empty result set is a clean
-- migration. See 0226, and `backfill-slugs-exist.spec.ts`, which now fails the
-- build for it.
--
-- The member split mirrors `buildModuleMemberPermissionKeys`, which filters the
-- module's namespace to keys ending `:view` or `:read`. Kept identical on
-- purpose: a backfilled organisation and a freshly seeded one must resolve to
-- the same capability, or behaviour depends on when the tenant signed up.
--
-- `ORG_ADMIN` is granted both as well, closing the same gap for organisations
-- created before this ships. No `OWNER` grant, and not because it was
-- forgotten: `access.service.ts` answers scope 'all' for `isOrgOwner` before any
-- grant is consulted.

SET lock_timeout = '5s';

--> statement-breakpoint
INSERT INTO "permissions" ("name", "resource", "action", "description", "module_key")
VALUES
  ('crm:customer-health:view', 'crm:customer-health', 'view',
   'Read customer health scores and the usage, engagement, support and sentiment inputs each one decomposes into',
   'crm'),
  ('crm:customer-health:manage', 'crm:customer-health', 'manage',
   'Recompute a customer''s health score from its sources and update the score shown on the customer record',
   'crm')
ON CONFLICT ("name") DO NOTHING;

--> statement-breakpoint
-- Owners and admins receive the module's whole namespace, which is what
-- `buildModuleAdminPermissionKeys` gives a newly seeded organisation.
INSERT INTO "role_permission_grants" ("org_id", "role_id", "permission_key", "scope")
SELECT r."org_id", r."id", k."permission_key", 'all'
FROM "roles" r
CROSS JOIN (VALUES
  ('crm:customer-health:view'),
  ('crm:customer-health:manage')
) AS k("permission_key")
WHERE r."is_system" = true
  AND r."slug" IN ('CRM_MODULE_OWNER', 'CRM_MODULE_ADMIN', 'ORG_ADMIN')
  AND EXISTS (SELECT 1 FROM "permissions" p WHERE p."name" = k."permission_key")
ON CONFLICT DO NOTHING;

--> statement-breakpoint
-- Members receive the read key only. A rep should see that an account they own
-- looks unhealthy and why; overwriting the number the whole organisation reads
-- as that customer's health is not their call.
INSERT INTO "role_permission_grants" ("org_id", "role_id", "permission_key", "scope")
SELECT r."org_id", r."id", 'crm:customer-health:view', 'all'
FROM "roles" r
WHERE r."is_system" = true
  AND r."slug" = 'CRM_MODULE_MEMBER'
  AND EXISTS (SELECT 1 FROM "permissions" p WHERE p."name" = 'crm:customer-health:view')
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
