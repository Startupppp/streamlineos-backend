-- Phase 5 ticket 01. The call-analysis surface becomes reachable:
-- `GET /crm/calls/:activityId/analysis` and `POST /crm/calls/:activityId/analysis`,
-- gated on `crm:call-analysis:view` and `crm:call-analysis:run`. This catalogues both
-- keys and backfills them onto organisations that already exist.
--
-- Two keys rather than one because they are two authorities. Reading what a call
-- contained is a manager's job; spending the organisation's AI credits is a different
-- decision, even though the cache makes the second call on a transcript free.
--
-- The slugs are `CRM_MODULE_OWNER|ADMIN|MEMBER`, which is what `seedSystemRolesForOrg`
-- actually mints -- NOT `CRM_ADMIN`, which is a `ROLE_TEMPLATES` slug an administrator may
-- create a role from and which no organisation is seeded with. Seven CRM migrations in
-- the 02xx series granted to `CRM_ADMIN`, matched zero rows, and left eighteen permissions
-- granted to nobody while reporting themselves clean; `backfill-slugs-exist.spec.ts` exists
-- because of that and would fail this file if it repeated the mistake.
--
-- `:view` goes to the member rung as well as the two admin rungs, because
-- `buildModuleMemberPermissionKeys` hands every `:view` key in the module's namespace to
-- `CRM_MODULE_MEMBER` at seed time. Granting it here is not generosity -- it is the
-- invariant that a backfilled organisation and a newly seeded one resolve to the same
-- capability, or a tenant's permissions depend on when they signed up. `:run` stops at the
-- two admin rungs, matching what the seeder does with a key that is neither `:view` nor
-- `:read`.
--
-- No `ORG_ADMIN` row is needed: `ROLE_DEFAULT_PERMISSIONS.ORG_ADMIN` is `ALL_PERMISSION_NAMES`,
-- so an organisation created after this ships gets both keys at seed time, and the org owner
-- resolves to scope 'all' before any grant is consulted.

SET lock_timeout = '5s';
--> statement-breakpoint
INSERT INTO "permissions" ("name", "resource", "action", "description", "module_key")
VALUES
  ('crm:call-analysis:view', 'crm:call-analysis', 'view',
   'Read the analysis of a completed call: talk ratio, question rate, objections and how they were handled, competitors named, and whether a next step was committed',
   'crm'),
  ('crm:call-analysis:run', 'crm:call-analysis', 'run',
   'Analyse a completed call''s transcript. A transcript that has already been analysed is returned from cache and costs nothing',
   'crm')
ON CONFLICT ("name") DO NOTHING;

--> statement-breakpoint
INSERT INTO "role_permission_grants" ("org_id", "role_id", "permission_key", "scope")
SELECT r."org_id", r."id", k."permission_key", 'all'
FROM "roles" r
CROSS JOIN (VALUES
  ('crm:call-analysis:view'),
  ('crm:call-analysis:run')
) AS k("permission_key")
WHERE r."is_system" = true
  AND r."slug" IN ('CRM_MODULE_OWNER', 'CRM_MODULE_ADMIN')
  AND EXISTS (SELECT 1 FROM "permissions" p WHERE p."name" = k."permission_key")
ON CONFLICT DO NOTHING;

--> statement-breakpoint
INSERT INTO "role_permission_grants" ("org_id", "role_id", "permission_key", "scope")
SELECT r."org_id", r."id", 'crm:call-analysis:view', 'all'
FROM "roles" r
WHERE r."is_system" = true
  AND r."slug" = 'CRM_MODULE_MEMBER'
  AND EXISTS (SELECT 1 FROM "permissions" p WHERE p."name" = 'crm:call-analysis:view')
ON CONFLICT DO NOTHING;

--> statement-breakpoint
-- Bump so cached permission resolutions are invalidated across every node at once; a role
-- that gained a key and a cache that has not heard about it is a 403 nobody can reproduce.
INSERT INTO "access_versions" ("org_id", "permissions_version", "updated_at")
SELECT DISTINCT r."org_id", 2, now()
FROM "roles" r
WHERE r."is_system" = true AND r."slug" LIKE 'CRM_MODULE_%'
ON CONFLICT ("org_id") DO UPDATE
SET "permissions_version" = "access_versions"."permissions_version" + 1,
    "updated_at" = now();
