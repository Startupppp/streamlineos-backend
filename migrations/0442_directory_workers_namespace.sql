-- Ticket 13 prerequisite. Directory's three worker keys lived under a `workforce:` prefix, and
-- `moduleScopedPermissions` slices on the FIRST segment, so a directory module template built from
-- the catalog silently missed all eight worker and engagement routes. They were never ghost keys —
-- HR_ADMIN and BRANCH_HR both hold them — so this is a rename with the grants carried across, not
-- a deletion.
--
-- `hr:workforce:manage` is a different key in a different namespace and is deliberately untouched.
SET lock_timeout = '5s';
--> statement-breakpoint
INSERT INTO "permissions" ("name", "resource", "action", "description", "module_key")
SELECT replace(p."name", 'workforce:workers:', 'directory:workers:'),
       'directory:workers',
       p."action",
       p."description",
       'directory'
FROM "permissions" p
WHERE p."name" LIKE 'workforce:workers:%'
ON CONFLICT ("name") DO NOTHING;
--> statement-breakpoint
-- Carry every existing grant across before the old key goes.
INSERT INTO "role_permission_grants" ("org_id", "role_id", "permission_key", "scope")
SELECT g."org_id", g."role_id",
       replace(g."permission_key", 'workforce:workers:', 'directory:workers:'),
       g."scope"
FROM "role_permission_grants" g
WHERE g."permission_key" LIKE 'workforce:workers:%'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "user_delegation_permissions" ("org_id", "delegation_id", "permission_key")
SELECT d."org_id", d."delegation_id",
       replace(d."permission_key", 'workforce:workers:', 'directory:workers:')
FROM "user_delegation_permissions" d
WHERE d."permission_key" LIKE 'workforce:workers:%'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
DELETE FROM "role_permission_grants" WHERE "permission_key" LIKE 'workforce:workers:%';
--> statement-breakpoint
DELETE FROM "user_delegation_permissions" WHERE "permission_key" LIKE 'workforce:workers:%';
--> statement-breakpoint
DELETE FROM "permissions" WHERE "name" LIKE 'workforce:workers:%';
--> statement-breakpoint
INSERT INTO "access_versions" ("org_id", "permissions_version", "updated_at")
SELECT o."id", 2, now() FROM "organizations" o
ON CONFLICT ("org_id") DO UPDATE
SET "permissions_version" = "access_versions"."permissions_version" + 1,
    "updated_at" = now();
