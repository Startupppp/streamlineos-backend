-- Ticket 12: chat, mail and calendar join the managed module set, so each gets an owner, admins,
-- members and per-person grants. Role templates only seed on role CREATION, so an existing
-- organisation would otherwise get the access screen with no rungs behind it.
--
-- Deliberately NOT touching MODULE_CATALOG: that list also decides plan gating, and a key whose
-- module sits there resolves to NO_MODULE unless the organisation has the module enabled. Mail and
-- calendar have no org_modules rows, so adding them there would 403 every mail and calendar route
-- platform-wide. The admin rung is derived from the union instead (MODULE_ADMIN_MODULES).
--
-- Permission sets are read from the `permissions` catalog by module_key rather than hardcoded, so
-- this stays correct as each module's vocabulary grows.
SET lock_timeout = '5s';
--> statement-breakpoint
INSERT INTO "permissions" ("name", "resource", "action", "description", "module_key")
SELECT m.key || ':access:' || a.action,
       m.key || ':access',
       a.action,
       CASE WHEN a.action = 'view'
            THEN 'View roles, permissions and assignments for the ' || m.key || ' module'
            ELSE 'View access administration for the ' || m.key || ' module; changing roles, permissions, or assignments additionally requires Module Admin, Module Owner, Org Admin, or Org Owner authority'
       END,
       m.key
FROM (VALUES ('chat'), ('mail'), ('calendar')) AS m(key)
CROSS JOIN (VALUES ('view'), ('manage')) AS a(action)
ON CONFLICT ("name") DO NOTHING;
--> statement-breakpoint
-- Owner, admin and member rungs for every organisation that already exists.
INSERT INTO "roles" ("name", "slug", "org_id", "is_system", "module_key", "rank")
SELECT initcap(m.key) || ' Module ' || r.label,
       upper(m.key) || '_MODULE_' || upper(r.label),
       o."id",
       true,
       m.key,
       r.rank
FROM "organizations" o
CROSS JOIN (VALUES ('chat'), ('mail'), ('calendar')) AS m(key)
CROSS JOIN (VALUES ('Owner', 15), ('Admin', 20), ('Member', 30)) AS r(label, rank)
ON CONFLICT ("slug", "org_id") DO NOTHING;
--> statement-breakpoint
-- Owners and admins get the module's whole namespace.
INSERT INTO "role_permission_grants" ("org_id", "role_id", "permission_key", "scope")
SELECT r."org_id", r."id", p."name", 'all'
FROM "roles" r
JOIN "permissions" p ON p."module_key" = r."module_key"
WHERE r."is_system" = true
  AND r."module_key" IN ('chat', 'mail', 'calendar')
  AND r."rank" IN (15, 20)
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- Members get only the reading keys, matching buildModuleMemberPermissionKeys.
INSERT INTO "role_permission_grants" ("org_id", "role_id", "permission_key", "scope")
SELECT r."org_id", r."id", p."name", 'all'
FROM "roles" r
JOIN "permissions" p ON p."module_key" = r."module_key"
WHERE r."is_system" = true
  AND r."module_key" IN ('chat', 'mail', 'calendar')
  AND r."rank" = 30
  AND (p."name" LIKE '%:view' OR p."name" LIKE '%:read')
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- Org admins administer access everywhere, so they gain the three new access pairs.
INSERT INTO "role_permission_grants" ("org_id", "role_id", "permission_key", "scope")
SELECT r."org_id", r."id", p."name", 'all'
FROM "roles" r
JOIN "permissions" p ON p."name" IN (
  'chat:access:view', 'chat:access:manage',
  'mail:access:view', 'mail:access:manage',
  'calendar:access:view', 'calendar:access:manage'
)
WHERE r."is_system" = true AND r."slug" = 'ORG_ADMIN'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- One lifecycle owner per module, seeded to the organisation owner, matching provisioning.
INSERT INTO "module_ownerships" ("org_id", "module_key", "owner_membership_id")
SELECT om."org_id", m.key, om."id"
FROM "organization_members" om
CROSS JOIN (VALUES ('chat'), ('mail'), ('calendar')) AS m(key)
WHERE om."is_owner" = true AND om."status" = 'ACTIVE'
ON CONFLICT ("org_id", "module_key") DO NOTHING;
--> statement-breakpoint
INSERT INTO "access_versions" ("org_id", "permissions_version", "updated_at")
SELECT o."id", 2, now()
FROM "organizations" o
ON CONFLICT ("org_id") DO UPDATE
SET "permissions_version" = "access_versions"."permissions_version" + 1,
    "updated_at" = now();
