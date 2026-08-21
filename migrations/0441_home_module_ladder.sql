-- Chat, mail and calendar are Home surfaces, not modules of their own: they are the communication
-- and self-service items every active member keeps. So they get ONE Home ladder — one owner, one
-- set of admins, one access screen — instead of three. Migration 0439 briefly created a separate
-- ladder per module; this replaces it.
--
-- Permission KEYS are untouched. `chat:*`, `mail:*` and `calendar:*` stay exactly as they are,
-- because a rename would break every grant already stored against them. The mapping from Home to
-- those three namespaces lives in code (`namespacesForModule`), which is what lets one ladder
-- administer all three.
SET lock_timeout = '5s';
--> statement-breakpoint
INSERT INTO "permissions" ("name", "resource", "action", "description", "module_key")
VALUES
  ('home:access:view', 'home:access', 'view', 'View roles, permissions and assignments for the home module', 'home'),
  ('home:access:manage', 'home:access', 'manage', 'View access administration for the home module; changing roles, permissions, or assignments additionally requires Module Admin, Module Owner, Org Admin, or Org Owner authority', 'home')
ON CONFLICT ("name") DO NOTHING;
--> statement-breakpoint
INSERT INTO "modules_catalog" ("module_key", "name", "description", "is_core", "is_paid_only", "sort_order", "status")
VALUES ('home', 'Home', 'Communication and self-service every active member keeps', true, false, 900, 'ACTIVE')
ON CONFLICT ("module_key") DO UPDATE
SET "is_core" = true, "is_paid_only" = false, "status" = 'ACTIVE';
--> statement-breakpoint
-- Retire the three short-lived per-module ladders. Only ones nobody was assigned to, so an
-- appointment made in between is never silently thrown away.
DELETE FROM "module_ownerships"
WHERE "module_key" IN ('chat', 'mail', 'calendar');
--> statement-breakpoint
DELETE FROM "role_permission_grants"
WHERE "role_id" IN (
  SELECT r."id" FROM "roles" r
  WHERE r."is_system" = true
    AND r."module_key" IN ('chat', 'mail', 'calendar')
    AND NOT EXISTS (SELECT 1 FROM "role_assignments" ra WHERE ra."role_id" = r."id")
);
--> statement-breakpoint
DELETE FROM "roles" r
WHERE r."is_system" = true
  AND r."module_key" IN ('chat', 'mail', 'calendar')
  AND NOT EXISTS (SELECT 1 FROM "role_assignments" ra WHERE ra."role_id" = r."id");
--> statement-breakpoint
INSERT INTO "roles" ("name", "slug", "org_id", "is_system", "module_key", "rank")
SELECT 'Home Module ' || r.label,
       'HOME_MODULE_' || upper(r.label),
       o."id",
       true,
       'home',
       r.rank
FROM "organizations" o
CROSS JOIN (VALUES ('Owner', 15), ('Admin', 20), ('Member', 30)) AS r(label, rank)
ON CONFLICT ("slug", "org_id") DO NOTHING;
--> statement-breakpoint
-- Home owns three namespaces, so its owner and admins hold all three plus its own access keys.
INSERT INTO "role_permission_grants" ("org_id", "role_id", "permission_key", "scope")
SELECT r."org_id", r."id", p."name", 'all'
FROM "roles" r
JOIN "permissions" p ON p."module_key" IN ('chat', 'mail', 'calendar', 'home')
WHERE r."is_system" = true AND r."module_key" = 'home' AND r."rank" IN (15, 20)
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "role_permission_grants" ("org_id", "role_id", "permission_key", "scope")
SELECT r."org_id", r."id", p."name", 'all'
FROM "roles" r
JOIN "permissions" p ON p."module_key" IN ('chat', 'mail', 'calendar', 'home')
WHERE r."is_system" = true AND r."module_key" = 'home' AND r."rank" = 30
  AND (p."name" LIKE '%:view' OR p."name" LIKE '%:read')
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "role_permission_grants" ("org_id", "role_id", "permission_key", "scope")
SELECT r."org_id", r."id", p."name", 'all'
FROM "roles" r
JOIN "permissions" p ON p."name" IN ('home:access:view', 'home:access:manage')
WHERE r."is_system" = true AND r."slug" = 'ORG_ADMIN'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
DELETE FROM "role_permission_grants"
WHERE "permission_key" IN (
  'chat:access:view', 'chat:access:manage',
  'mail:access:view', 'mail:access:manage',
  'calendar:access:view', 'calendar:access:manage'
);
--> statement-breakpoint
DELETE FROM "permissions"
WHERE "name" IN (
  'chat:access:view', 'chat:access:manage',
  'mail:access:view', 'mail:access:manage',
  'calendar:access:view', 'calendar:access:manage'
);
--> statement-breakpoint
INSERT INTO "module_ownerships" ("org_id", "module_key", "owner_membership_id")
SELECT om."org_id", 'home', om."id"
FROM "organization_members" om
WHERE om."is_owner" = true AND om."status" = 'ACTIVE'
ON CONFLICT ("org_id", "module_key") DO NOTHING;
--> statement-breakpoint
INSERT INTO "access_versions" ("org_id", "permissions_version", "updated_at")
SELECT o."id", 2, now() FROM "organizations" o
ON CONFLICT ("org_id") DO UPDATE
SET "permissions_version" = "access_versions"."permissions_version" + 1,
    "updated_at" = now();
