SET lock_timeout = '5s';
--> statement-breakpoint
INSERT INTO "role_permission_grants" ("org_id", "role_id", "permission_key", "scope")
SELECT r."org_id", r."id", 'calendar:admin:manage', 'all'
FROM "roles" r
WHERE r."is_system" = true
  AND r."slug" IN ('OWNER', 'ORG_ADMIN')
  AND EXISTS (SELECT 1 FROM "permissions" p WHERE p."name" = 'calendar:admin:manage')
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "access_versions" ("org_id", "permissions_version", "updated_at")
SELECT DISTINCT r."org_id", 2, now()
FROM "roles" r
WHERE r."is_system" = true AND r."slug" IN ('OWNER', 'ORG_ADMIN')
ON CONFLICT ("org_id") DO UPDATE
SET "permissions_version" = "access_versions"."permissions_version" + 1,
    "updated_at" = now();
