-- Home is universal to every active member, so there is nothing to grant per role and no access
-- screen to open. This removes the ladder 0441 seeded and the keys 0450 backfilled onto it.
--
-- What is NOT touched: Home still ADMINISTERS the chat, mail, calendar and notifications
-- namespaces. That mapping lives in ADDITIONAL_MODULE_NAMESPACES (module-vocabulary.ts) and is
-- independent of whether a module is access-managed, so those keys keep resolving exactly as
-- before. Ordinary members reach chat/mail/calendar through EMPLOYEE_SELF_SERVICE_GRANTS, which is
-- derived from ROLE_DEFAULT_PERMISSIONS["MEMBER"] and merged before any role is read — no member
-- loses a surface here. `home` also stays in modules_catalog as a core module; it is the product,
-- not the access ladder, that survives.
SET lock_timeout = '5s';
--> statement-breakpoint
DELETE FROM "role_permission_grants"
WHERE "permission_key" IN ('home:access:view', 'home:access:manage');
--> statement-breakpoint
DELETE FROM "user_permission_grants"
WHERE "permission_key" IN ('home:access:view', 'home:access:manage');
--> statement-breakpoint
DELETE FROM "user_delegation_permissions"
WHERE "permission_key" IN ('home:access:view', 'home:access:manage');
--> statement-breakpoint
-- Anything hanging off the ladder roles goes before the roles themselves.
DELETE FROM "role_assignments"
WHERE "role_id" IN (
  SELECT "id" FROM "roles"
  WHERE "slug" IN ('HOME_MODULE_OWNER', 'HOME_MODULE_ADMIN', 'HOME_MODULE_MEMBER')
);
--> statement-breakpoint
DELETE FROM "group_role_assignments"
WHERE "role_id" IN (
  SELECT "id" FROM "roles"
  WHERE "slug" IN ('HOME_MODULE_OWNER', 'HOME_MODULE_ADMIN', 'HOME_MODULE_MEMBER')
);
--> statement-breakpoint
DELETE FROM "role_permission_grants"
WHERE "role_id" IN (
  SELECT "id" FROM "roles"
  WHERE "slug" IN ('HOME_MODULE_OWNER', 'HOME_MODULE_ADMIN', 'HOME_MODULE_MEMBER')
);
--> statement-breakpoint
DELETE FROM "roles"
WHERE "is_system" = true
  AND "slug" IN ('HOME_MODULE_OWNER', 'HOME_MODULE_ADMIN', 'HOME_MODULE_MEMBER');
--> statement-breakpoint
DELETE FROM "module_ownerships" WHERE "module_key" = 'home';
--> statement-breakpoint
-- The catalog sync only upserts the keys it knows about; it never removes a retired one.
DELETE FROM "permissions"
WHERE "name" IN ('home:access:view', 'home:access:manage');
--> statement-breakpoint
-- Resolution is cached per (userId, orgId) and busted by permissions_version.
INSERT INTO "access_versions" ("org_id", "permissions_version", "updated_at")
SELECT o."id", 2, now()
FROM "organizations" o
ON CONFLICT ("org_id") DO UPDATE
SET "permissions_version" = "access_versions"."permissions_version" + 1,
    "updated_at" = now();
