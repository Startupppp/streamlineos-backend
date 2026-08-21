-- HR custom-field definitions moved from `settings:custom-fields:manage` to `hr:custom-fields:manage`
-- so an HR owner can manage them without organisation-wide settings authority. Role templates only
-- grant on role CREATION -- `seed-system-roles.spec.ts` asserts a re-seed must not touch an existing
-- role's grants -- so a new key never reaches an organisation that already exists. This backfills it
-- onto the two module roles the template gives it to, and nothing else.
SET lock_timeout = '5s';
--> statement-breakpoint
INSERT INTO "role_permission_grants" ("org_id", "role_id", "permission_key", "scope")
SELECT r."org_id", r."id", 'hr:custom-fields:manage', 'all'
FROM "roles" r
WHERE r."is_system" = true
  AND r."slug" IN ('HR_MODULE_OWNER', 'HR_MODULE_ADMIN')
  AND EXISTS (SELECT 1 FROM "permissions" p WHERE p."name" = 'hr:custom-fields:manage')
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "access_versions" ("org_id", "permissions_version", "updated_at")
SELECT DISTINCT r."org_id", 2, now()
FROM "roles" r
WHERE r."is_system" = true AND r."slug" IN ('HR_MODULE_OWNER', 'HR_MODULE_ADMIN')
ON CONFLICT ("org_id") DO UPDATE
SET "permissions_version" = "access_versions"."permissions_version" + 1,
    "updated_at" = now();
