-- `namespacesForModule` returned only the EXTRA namespaces a module administers, so Home -- which
-- administers chat, mail, calendar and notifications -- lost its own. The Home role templates were
-- therefore built without `home:access:view` / `home:access:manage`, and a Home module owner could
-- not open the access screen they administer. Every other module passed by coincidence: its keys
-- start with its own name.
--
-- Role templates only grant on role CREATION -- `seed-system-roles.spec.ts` asserts a re-seed must
-- not touch an existing role's grants -- so the corrected template reaches new organisations only.
-- This backfills the same keys onto the Home roles that already exist, and nothing else.
--
-- Owner and admin get both keys; member gets the read key only, which is what
-- `buildModuleMemberPermissionKeys` produces and what every other module's member role already has.
SET lock_timeout = '5s';
--> statement-breakpoint
INSERT INTO "role_permission_grants" ("org_id", "role_id", "permission_key", "scope")
SELECT r."org_id", r."id", k."permission_key", 'all'
FROM "roles" r
CROSS JOIN (VALUES ('home:access:view'), ('home:access:manage')) AS k("permission_key")
WHERE r."is_system" = true
  AND r."slug" IN ('HOME_MODULE_OWNER', 'HOME_MODULE_ADMIN')
  AND EXISTS (SELECT 1 FROM "permissions" p WHERE p."name" = k."permission_key")
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "role_permission_grants" ("org_id", "role_id", "permission_key", "scope")
SELECT r."org_id", r."id", 'home:access:view', 'all'
FROM "roles" r
WHERE r."is_system" = true
  AND r."slug" = 'HOME_MODULE_MEMBER'
  AND EXISTS (SELECT 1 FROM "permissions" p WHERE p."name" = 'home:access:view')
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- Resolution is cached per (userId, orgId) and busted by permissions_version, so anyone who just
-- gained the key must not wait for their cache to expire.
INSERT INTO "access_versions" ("org_id", "permissions_version", "updated_at")
SELECT DISTINCT r."org_id", 2, now()
FROM "roles" r
WHERE r."is_system" = true
  AND r."slug" IN ('HOME_MODULE_OWNER', 'HOME_MODULE_ADMIN', 'HOME_MODULE_MEMBER')
ON CONFLICT ("org_id") DO UPDATE
SET "permissions_version" = "access_versions"."permissions_version" + 1,
    "updated_at" = now();
