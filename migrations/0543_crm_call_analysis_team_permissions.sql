-- Phase 5 ticket 02. `crm:call-analysis:view-team` -- the key that lets somebody read
-- a call they were not on, and the gate on `GET /crm/calls/coaching`. Catalogued in
-- `permissions/crm.ts` and backfilled here onto organisations that already exist.
--
-- The key does NOT end in `:view` or `:read`, and that is the whole reason it can exist.
-- `buildModuleMemberPermissionKeys` hands every key with those suffixes to
-- `CRM_MODULE_MEMBER`, so naming this `crm:call-analysis:team-view` would have granted
-- every rep the right to read every other rep's calls at seed time -- the leaderboard the
-- ticket exists to prevent, arrived at through a naming convention. So this goes to the
-- two admin rungs only, and there is deliberately no CRM_MODULE_MEMBER statement in this
-- file. `call-analysis-team-permissions.spec.ts` asserts that absence rather than leaving
-- it to be noticed.
--
-- Before this key, `crm:call-analysis:view` alone let any CRM member read any call's
-- analysis -- that is what shipped in 0540/0541 and what this narrows. `:view` keeps its
-- meaning: you may read the analysis of a call you were on. Reading anyone else's now
-- needs this key AND the rep's window to have elapsed or the rep to have shared it; the
-- window is enforced in `call-analysis-visibility.ts` and binds an org owner as firmly as
-- anyone else, so no grant in this file is sufficient on its own.
--
-- The slugs are `CRM_MODULE_OWNER|ADMIN`, which is what `seedSystemRolesForOrg` actually
-- mints -- NOT `CRM_ADMIN`, which is a `ROLE_TEMPLATES` slug an administrator may create a
-- role from and which no organisation is seeded with. Seven CRM migrations in the 02xx
-- series granted to `CRM_ADMIN`, matched zero rows, and reported themselves clean;
-- `backfill-slugs-exist.spec.ts` exists because of that.
--
-- No `ORG_ADMIN` row is needed: `ROLE_DEFAULT_PERMISSIONS.ORG_ADMIN` is
-- `ALL_PERMISSION_NAMES`, so an organisation created after this ships gets the key at seed
-- time, and the org owner resolves to scope 'all' before any grant is consulted.

SET lock_timeout = '5s';
--> statement-breakpoint
INSERT INTO "permissions" ("name", "resource", "action", "description", "module_key")
VALUES
  ('crm:call-analysis:view-team', 'crm:call-analysis', 'view-team',
   'Read call analyses for calls you were not on, once the rep has shared one or their private window has elapsed, and see the team''s coaching digest',
   'crm')
ON CONFLICT ("name") DO NOTHING;

--> statement-breakpoint
INSERT INTO "role_permission_grants" ("org_id", "role_id", "permission_key", "scope")
SELECT r."org_id", r."id", 'crm:call-analysis:view-team', 'all'
FROM "roles" r
WHERE r."is_system" = true
  AND r."slug" IN ('CRM_MODULE_OWNER', 'CRM_MODULE_ADMIN')
  AND EXISTS (SELECT 1 FROM "permissions" p WHERE p."name" = 'crm:call-analysis:view-team')
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
