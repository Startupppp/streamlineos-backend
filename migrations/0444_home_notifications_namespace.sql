-- Notifications became a Home namespace after 0441 had already granted Home its namespaces, so
-- Home owners and admins in existing organisations would hold chat, mail and calendar but not the
-- notification template, policy, provider, event and broadcast administration they now administer.
-- Receiving and managing one's OWN notifications is untouched and stays universal — those 28 routes
-- carry no permission gate at all.
SET lock_timeout = '5s';
--> statement-breakpoint
INSERT INTO "role_permission_grants" ("org_id", "role_id", "permission_key", "scope")
SELECT r."org_id", r."id", p."name", 'all'
FROM "roles" r
JOIN "permissions" p ON p."module_key" = 'notifications'
WHERE r."is_system" = true AND r."module_key" = 'home' AND r."rank" IN (15, 20)
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "role_permission_grants" ("org_id", "role_id", "permission_key", "scope")
SELECT r."org_id", r."id", p."name", 'all'
FROM "roles" r
JOIN "permissions" p ON p."module_key" = 'notifications'
WHERE r."is_system" = true AND r."module_key" = 'home' AND r."rank" = 30
  AND (p."name" LIKE '%:view' OR p."name" LIKE '%:read')
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "access_versions" ("org_id", "permissions_version", "updated_at")
SELECT o."id", 2, now() FROM "organizations" o
ON CONFLICT ("org_id") DO UPDATE
SET "permissions_version" = "access_versions"."permissions_version" + 1,
    "updated_at" = now();
