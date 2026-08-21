-- Ticket 13. Workflows, blog and directory join the managed set, each gaining an owner, admins,
-- members and per-person grants. Notifications does NOT: it is a Home surface, administered by the
-- Home ladder alongside chat, mail and calendar.
--
-- `assertModuleAccessPolicy` refuses before any authority check when isModuleEnabled is false, and
-- that answers true only for a module the catalog marks core or an organisation has enabled. None
-- of these three is a paid module, so they are recorded as core — otherwise their access screens
-- would exist and be unopenable.
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
FROM (VALUES ('workflows'), ('blog'), ('directory')) AS m(key)
CROSS JOIN (VALUES ('view'), ('manage')) AS a(action)
ON CONFLICT ("name") DO NOTHING;
--> statement-breakpoint
INSERT INTO "modules_catalog" ("module_key", "name", "description", "is_core", "is_paid_only", "sort_order", "status")
VALUES
  ('workflows', 'Workflows', 'Workflow authoring, scheduling and approvals', true, false, 930, 'ACTIVE'),
  ('blog', 'Blog', 'Public blog posts and categories', true, false, 940, 'ACTIVE'),
  ('directory', 'Directory', 'People directory and workforce records', true, false, 950, 'ACTIVE')
ON CONFLICT ("module_key") DO UPDATE
SET "is_core" = true, "is_paid_only" = false, "status" = 'ACTIVE';
--> statement-breakpoint
INSERT INTO "roles" ("name", "slug", "org_id", "is_system", "module_key", "rank")
SELECT initcap(m.key) || ' Module ' || r.label,
       upper(m.key) || '_MODULE_' || upper(r.label),
       o."id",
       true,
       m.key,
       r.rank
FROM "organizations" o
CROSS JOIN (VALUES ('workflows'), ('blog'), ('directory')) AS m(key)
CROSS JOIN (VALUES ('Owner', 15), ('Admin', 20), ('Member', 30)) AS r(label, rank)
ON CONFLICT ("slug", "org_id") DO NOTHING;
--> statement-breakpoint
INSERT INTO "role_permission_grants" ("org_id", "role_id", "permission_key", "scope")
SELECT r."org_id", r."id", p."name", 'all'
FROM "roles" r
JOIN "permissions" p ON p."module_key" = r."module_key"
WHERE r."is_system" = true
  AND r."module_key" IN ('workflows', 'blog', 'directory')
  AND r."rank" IN (15, 20)
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "role_permission_grants" ("org_id", "role_id", "permission_key", "scope")
SELECT r."org_id", r."id", p."name", 'all'
FROM "roles" r
JOIN "permissions" p ON p."module_key" = r."module_key"
WHERE r."is_system" = true
  AND r."module_key" IN ('workflows', 'blog', 'directory')
  AND r."rank" = 30
  AND (p."name" LIKE '%:view' OR p."name" LIKE '%:read')
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "role_permission_grants" ("org_id", "role_id", "permission_key", "scope")
SELECT r."org_id", r."id", p."name", 'all'
FROM "roles" r
JOIN "permissions" p ON p."name" IN (
  'workflows:access:view', 'workflows:access:manage',
  'blog:access:view', 'blog:access:manage',
  'directory:access:view', 'directory:access:manage'
)
WHERE r."is_system" = true AND r."slug" = 'ORG_ADMIN'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "module_ownerships" ("org_id", "module_key", "owner_membership_id")
SELECT om."org_id", m.key, om."id"
FROM "organization_members" om
CROSS JOIN (VALUES ('workflows'), ('blog'), ('directory')) AS m(key)
WHERE om."is_owner" = true AND om."status" = 'ACTIVE'
ON CONFLICT ("org_id", "module_key") DO NOTHING;
--> statement-breakpoint
INSERT INTO "access_versions" ("org_id", "permissions_version", "updated_at")
SELECT o."id", 2, now() FROM "organizations" o
ON CONFLICT ("org_id") DO UPDATE
SET "permissions_version" = "access_versions"."permissions_version" + 1,
    "updated_at" = now();
